import { describe, expect, it } from 'vitest';
import { androidOriginFromFingerprint, expectedPasskeyOrigins, parseAndroidOrigins } from '../src/auth/passkey-origins.js';
import { deviceName } from '../src/auth/device-name.js';
import { MfaPolicyService } from '../src/auth/mfa-policy.service.js';
import { testEnv } from './helpers.js';

// The release key's public fingerprint (keytool -list -v), and the origin
// Android's Credential Manager reports for an app signed with it.
const FINGERPRINT = '42:07:B1:E4:EF:E7:19:69:A9:18:F5:1F:34:FF:27:C6:BE:90:97:3F:52:53:0E:F9:C4:74:9B:D8:02:69:47:88';
const ANDROID = 'android:apk-key-hash:Qgex5O_nGWmpGPUfNP8nxr6Qlz9SUw75xHSb2AJpR4g';

describe('passkey origins for the Android app', () => {
  it('derives the android:apk-key-hash origin from a certificate fingerprint', () => {
    expect(androidOriginFromFingerprint(FINGERPRINT)).toBe(ANDROID);
  });

  it('parses a comma list, trims and de-duplicates it', () => {
    expect(parseAndroidOrigins('')).toEqual([]);
    expect(parseAndroidOrigins(undefined)).toEqual([]);
    expect(parseAndroidOrigins(` ${ANDROID} ,${ANDROID},`)).toEqual([ANDROID]);
  });

  it('refuses anything that is not an apk-key-hash origin', () => {
    for (const bad of ['https://evil.example', 'android:apk-key-hash:short', `${ANDROID}x`, 'android:apk-key-hash:Qgex5O+nGWmpGPUfNP8nxr6Qlz9SUw75xHSb2AJpR4g']) {
      expect(() => parseAndroidOrigins(bad)).toThrow();
    }
  });

  it('a malformed value stops the API at startup', () => {
    expect(() => testEnv({ PASSKEY_ANDROID_ORIGINS: 'https://evil.example' })).toThrow(/PASSKEY_ANDROID_ORIGINS/);
  });

  it('accepts the web origin always, plus the configured app origins; the RP id stays the web host', () => {
    expect(expectedPasskeyOrigins(testEnv())).toEqual(['https://vault.test']);
    expect(expectedPasskeyOrigins(testEnv({ PASSKEY_ANDROID_ORIGINS: ANDROID }))).toEqual(['https://vault.test', ANDROID]);
  });
});

describe('second-factor policy rule', () => {
  it('ADMIN always; other roles when listed; anyone enrolled', () => {
    expect(MfaPolicyService.isRequired('ADMIN', false, [])).toBe(true);
    expect(MfaPolicyService.isRequired('VIEWER', false, ['ADMIN'])).toBe(false);
    expect(MfaPolicyService.isRequired('VIEWER', false, ['ADMIN', 'VIEWER'])).toBe(true);
    expect(MfaPolicyService.isRequired('EXTERNAL', true, ['ADMIN'])).toBe(true);
  });
});

describe('device names for the signed-in devices list', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on Mac'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['TrustVault Android app (Android 14)', 'TrustVault app on Android 14'],
    ['TrustVault Android app', 'TrustVault Android app'],
    [null, 'Unknown device'],
  ])('%s → %s', (ua, name) => {
    expect(deviceName(ua)).toBe(name);
  });
});
