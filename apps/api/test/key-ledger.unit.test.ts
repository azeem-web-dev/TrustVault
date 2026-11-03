import { describe, expect, it } from 'vitest';
import { ledgerEntryHash, ticketKid, verifyTicketMac, ZERO_HASH } from '../src/crypto/key-ledger.js';

// The same vectors as keyd/src/ticket.rs and ledger.rs: the database, keyd,
// the API and tools/reconcile-ledger.mjs must agree byte for byte.
const DB_TICKET = 'tv-unwrap-ticket-v1|2be527e44cdf6898|44444444-4444-4444-8444-444444444444|download|11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|33333333-3333-4333-8333-333333333333|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|55555555-5555-4555-8555-555555555555|42|1800000000|1800000030|7d6d9da05d1c103b2683c0d957bc7b24d0c77b0e2c901a8ba266b1d8b085f567';

describe('cross-implementation vectors', () => {
  it('accepts a ticket minted by the database function', () => {
    const key = Buffer.alloc(32, 5);
    expect(ticketKid(key)).toBe('2be527e44cdf6898');
    const keys = new Map([[ticketKid(key), key]]);
    expect(verifyTicketMac(keys, DB_TICKET)).toMatchObject({ action: 'download', auditSeq: 42n, iat: 1_800_000_000, exp: 1_800_000_030 });
    expect(() => verifyTicketMac(keys, DB_TICKET.slice(0, -1) + '6')).toThrow('bad ticket mac');
  });

  it('hashes a ledger entry exactly like keyd', () => {
    expect(ledgerEntryHash(ZERO_HASH, {
      seq: 7, ts: 1_800_000_000_123, event: 'unwrap', action: 'download', tid: '44444444-4444-4444-8444-444444444444', user: null, doc: 'd', ver: null,
      audit_id: 'é', audit_seq: 42, key_id: 'keyd-g1-blob', aad_sha256: null, result: 'ok', detail: null, prev: '', hash: '',
    })).toBe('fed2e04dbb295be6a1d85f7776b9e6ccc1b9766a388ca13de65315f6fccee09c');
  });
});
