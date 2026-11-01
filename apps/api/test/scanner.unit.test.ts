import { describe, expect, it } from 'vitest';
import { ClamdScanner, ScannerUnavailable } from '../src/scanning/malware-scanner.js';
import { loadEnv } from '../src/config/env.js';

describe('clamd replies: only an exact OK is clean', () => {
  it('reads OK and FOUND', () => {
    expect(ClamdScanner.parseReply('stream: OK\0')).toEqual({ clean: true });
    expect(ClamdScanner.parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
  });
  for (const reply of ['', 'stream: OK but not really', 'INSTREAM size limit exceeded. ERROR', 'stream: ERROR', 'OK']) {
    it(`treats ${JSON.stringify(reply)} as an error, never as clean`, () => {
      expect(() => ClamdScanner.parseReply(reply)).toThrow(ScannerUnavailable);
    });
  }
});

describe('production refuses to run without a scanner', () => {
  const base = {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://vault.example', DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', KEY_PROVIDER: 'keyd',
  };
  it('throws when SCANNER is not clamd', () => {
    expect(() => loadEnv({ ...base })).toThrow(/SCANNER=clamd/);
    expect(() => loadEnv({ ...base, SCANNER: 'none' })).toThrow(/SCANNER=clamd/);
  });
  it('starts with clamd', () => {
    expect(loadEnv({ ...base, SCANNER: 'clamd' }).SCANNER).toBe('clamd');
  });
});
