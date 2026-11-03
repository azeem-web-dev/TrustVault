import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, matchTotp, otpauthUri, STEP_SECONDS, totpAt } from '../src/auth/totp.js';

// Codes must be the ones Google Authenticator (or any RFC 6238 app) shows,
// not something that only agrees with itself. RFC 6238 Appendix B, SHA1.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP matches RFC 6238 (what authenticator apps compute)', () => {
  it.each(VECTORS)('T = %i s gives %s', (seconds, code) => {
    // The RFC lists 8 digits; apps show the last 6 (same truncation, mod 10^6).
    expect(totpAt(RFC_SECRET, currentStep(seconds * 1000))).toBe(code);
    expect(matchTotp(RFC_SECRET, code, seconds * 1000)).toBe(Math.floor(seconds / STEP_SECONDS));
  });

  it('accepts one step of clock drift either way, and no more', () => {
    const now = 1111111111 * 1000;
    const step = currentStep(now);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it('refuses anything that is not exactly six digits', () => {
    for (const bad of ['', '12345', '1234567', '12345a', ' 287082']) expect(matchTotp(RFC_SECRET, bad, 59_000)).toBeNull();
  });

  it('base32 round-trips the secret the way apps read it (RFC 4648, no padding)', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_SECRET);
  });

  it('otpauth URI has the label, issuer and parameters Google Authenticator expects', () => {
    const uri = new URL(otpauthUri('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'ana@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/TrustVault:ana@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', issuer: 'TrustVault', algorithm: 'SHA1', digits: '6', period: '30',
    });
  });
});
