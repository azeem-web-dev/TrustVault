import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createUser, ORIGIN, resetState, startApp, type Session, type TestApp, type TestUser } from './helpers.js';

// Signed-in devices (THREATS.md S23): everyone sees and ends their own
// sessions, never anyone else's.

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetState(t.app); });

const UA = {
  laptop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  phone: 'TrustVault Android app (Android 14)',
};

async function signIn(u: TestUser, ua: string): Promise<Session> {
  const res: request.Response = await t.http.post('/api/auth/login').set('Origin', ORIGIN).set('User-Agent', ua).send({ email: u.email, password: u.password }).expect(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-tv_session='))!.split(';')[0]!;
  return { cookie, csrf: res.body.csrfToken, userId: res.body.user.id };
}

describe('signed-in devices', () => {
  let ana: TestUser;
  let bob: TestUser;
  beforeEach(async () => {
    ana = await createUser({ email: 'dev-ana@t.io', role: 'OWNER' });
    bob = await createUser({ email: 'dev-bob@t.io', role: 'OWNER' });
  });

  it('lists only my own live sessions, with a device name and which one is this', async () => {
    const laptop = await signIn(ana, UA.laptop);
    await signIn(ana, UA.phone);
    await signIn(bob, UA.laptop);
    const res = await as(t, laptop).get('/api/auth/sessions').expect(200);
    const list = res.body.sessions as { id: string; device: string; current: boolean; authLevel: string; ip: string | null; createdAt: string; lastSeenAt: string }[];
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.device).sort()).toEqual(['Chrome on Windows', 'TrustVault app on Android 14']);
    expect(list.filter((s) => s.current).map((s) => s.device)).toEqual(['Chrome on Windows']);
    expect(list[0]).toHaveProperty('lastSeenAt');
    expect(list[0]!.authLevel).toBe('password');
  });

  it('signs one other device out; that cookie is dead and the refusal recorded', async () => {
    const laptop = await signIn(ana, UA.laptop);
    const phone = await signIn(ana, UA.phone);
    const list = (await as(t, laptop).get('/api/auth/sessions')).body.sessions as { id: string; current: boolean }[];
    const phoneId = list.find((s) => !s.current)!.id;
    await as(t, laptop).delete(`/api/auth/sessions/${phoneId}`).expect(204);
    await as(t, phone).get('/api/documents').expect(401);
    await as(t, laptop).get('/api/documents').expect(200);
    const rejected = await auditRows(`action = 'auth.session_rejected' AND target_id = $1`, [phoneId]);
    expect(rejected[0]!.reason).toBe('signed_out_by_user');
    expect((await auditRows(`action = 'auth.session_revoke' AND target_id = $1`, [phoneId]))).toHaveLength(1);
  });

  it('cannot touch another person’s session: it answers 404 like a made-up id', async () => {
    const mine = await signIn(ana, UA.laptop);
    const theirs = await signIn(bob, UA.phone);
    const bobId = ((await as(t, theirs).get('/api/auth/sessions')).body.sessions as { id: string }[])[0]!.id;
    await as(t, mine).delete(`/api/auth/sessions/${bobId}`).expect(404);
    await as(t, mine).delete(`/api/auth/sessions/${randomUUID()}`).expect(404);
    await as(t, theirs).get('/api/documents').expect(200);
  });

  it('this device is ended by signing out, not from the list', async () => {
    const mine = await signIn(ana, UA.laptop);
    const id = ((await as(t, mine).get('/api/auth/sessions')).body.sessions as { id: string }[])[0]!.id;
    await as(t, mine).delete(`/api/auth/sessions/${id}`).expect(400);
  });

  it('"sign out all other devices" keeps only this one', async () => {
    const laptop = await signIn(ana, UA.laptop);
    const phone = await signIn(ana, UA.phone);
    const tablet = await signIn(ana, UA.phone);
    const bobs = await signIn(bob, UA.laptop);
    const res = await as(t, laptop).post('/api/auth/sessions/revoke-others').expect(200);
    expect(res.body.ended).toBe(2);
    await as(t, phone).get('/api/documents').expect(401);
    await as(t, tablet).get('/api/documents').expect(401);
    await as(t, laptop).get('/api/documents').expect(200);
    await as(t, bobs).get('/api/documents').expect(200);
    const rows = await auditRows(`actor_id = $1 AND action = 'auth.sessions_revoke_others'`, [ana.id]);
    expect(rows.at(-1)!.details).toEqual({ sessionsEnded: 2 });
  });

  it('ended sessions drop off the list', async () => {
    const laptop = await signIn(ana, UA.laptop);
    const phone = await signIn(ana, UA.phone);
    await as(t, phone).post('/api/auth/logout');
    expect((await as(t, laptop).get('/api/auth/sessions')).body.sessions).toHaveLength(1);
  });
});
