import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/**
 * In-process stand-in for Sigstore's Rekor, used as a `fetch` replacement.
 * It behaves like the real log for what TrustVault uses: it checks the
 * Ed25519 signature before accepting a rekord entry, stores only the
 * message's SHA-256, answers 409 with a Location for duplicates, and signs
 * each receipt (signed entry timestamp) with its own P-256 key. Modes make
 * it misbehave the ways the tools must survive.
 */
export type RekorMode = 'normal' | 'down' | 'wrong-entry' | 'bad-receipt';

interface Stored { uuid: string; entry: { body: string; integratedTime: number; logID: string; logIndex: number; verification: { signedEntryTimestamp: string } }; pem: string; digest: string }

const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
};

export class FakeRekor {
  readonly base = 'https://rekor.fake';
  mode: RekorMode = 'normal';
  readonly publicKeyPem: string;
  submissions = 0;
  private readonly key: KeyObject;
  private readonly otherKey: KeyObject;
  private readonly logID: string;
  private readonly entries: Stored[] = [];
  private nextIndex = 1_000;
  /** Seconds since epoch used for integratedTime; tests can move it. */
  now = Math.floor(Date.now() / 1000);

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    this.otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.logID = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  }

  get size(): number {
    return this.entries.length;
  }

  private receipt(body: string, logIndex: number, integratedTime: number, signer = this.key) {
    const payload = canonicalJson({ body, integratedTime, logID: this.logID, logIndex });
    return { body, integratedTime, logID: this.logID, logIndex, verification: { signedEntryTimestamp: sign('sha256', Buffer.from(payload), signer).toString('base64') } };
  }

  private json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  private respondWith(s: Stored): Record<string, unknown> {
    if (this.mode === 'bad-receipt') return { [s.uuid]: this.receipt(s.entry.body, s.entry.logIndex, s.entry.integratedTime, this.otherKey) };
    if (this.mode === 'wrong-entry') {
      const other = this.entries.find((e) => e !== s && e.pem === s.pem);
      if (other) return { [other.uuid]: other.entry };
    }
    return { [s.uuid]: s.entry };
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (this.mode === 'down') return this.json(503, { message: 'unavailable' });
    const body = init.body ? JSON.parse(String(init.body)) : null;

    if (url.pathname === '/api/v1/log/entries' && init.method === 'POST') {
      this.submissions++;
      const data = Buffer.from(body.spec.data.content, 'base64');
      const pem = Buffer.from(body.spec.signature.publicKey.content, 'base64').toString();
      const sig = Buffer.from(body.spec.signature.content, 'base64');
      if (body.kind !== 'rekord' || !verify(null, data, createPublicKey(pem), sig)) return this.json(400, { message: 'signature does not verify' });
      const digest = createHash('sha256').update(data).digest('hex');
      const dup = this.entries.find((e) => e.digest === digest && e.pem === pem);
      if (dup) return this.json(409, { message: 'exists' }, { location: `/api/v1/log/entries/${dup.uuid}` });
      const stored = {
        apiVersion: '0.0.1', kind: 'rekord',
        spec: { data: { hash: { algorithm: 'sha256', value: digest } }, signature: { content: body.spec.signature.content, format: 'x509', publicKey: { content: body.spec.signature.publicKey.content } } },
      };
      const b64 = Buffer.from(JSON.stringify(stored)).toString('base64');
      const uuid = 'f00d' + createHash('sha256').update(b64).digest('hex').slice(0, 12) + createHash('sha256').update(`${digest}${pem}`).digest('hex');
      const s: Stored = { uuid, entry: this.receipt(b64, this.nextIndex++, this.now), pem, digest };
      this.entries.push(s);
      return this.json(201, this.respondWith(s), { location: `/api/v1/log/entries/${uuid}` });
    }
    const m = /^\/api\/v1\/log\/entries\/([0-9a-f]+)$/.exec(url.pathname);
    if (m && (!init.method || init.method === 'GET')) {
      const s = this.entries.find((e) => e.uuid === m[1]);
      return s ? this.json(200, this.respondWith(s)) : this.json(404, { message: 'not found' });
    }
    if (url.pathname === '/api/v1/index/retrieve' && init.method === 'POST') {
      const pem = Buffer.from(body.publicKey.content, 'base64').toString();
      return this.json(200, this.entries.filter((e) => e.pem.replace(/\s/g, '') === pem.replace(/\s/g, '')).map((e) => e.uuid));
    }
    if (url.pathname === '/api/v1/log/entries/retrieve' && init.method === 'POST') {
      return this.json(200, (body.entryUUIDs as string[]).map((u) => this.entries.find((e) => e.uuid === u)).filter(Boolean).map((s) => this.respondWith(s!)));
    }
    return this.json(404, { message: 'no route' });
  };
}
