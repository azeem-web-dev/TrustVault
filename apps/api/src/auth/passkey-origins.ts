// Origins a passkey assertion may come from. A browser reports the page's
// origin; the Android app (Credential Manager) reports
// "android:apk-key-hash:<base64url SHA-256 of the signing certificate>",
// which Android only lets the app signed with that key claim. The relying
// party id stays the web hostname, so a passkey made in either works in both
// (Digital Asset Links tie the app to the site). THREATS.md S22.

const ANDROID_ORIGIN = /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/;

/** Parses PASSKEY_ANDROID_ORIGINS (comma list). Throws on anything malformed. */
export function parseAndroidOrigins(raw: string | undefined): string[] {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!ANDROID_ORIGIN.test(item)) throw new Error('PASSKEY_ANDROID_ORIGINS: each entry must be android:apk-key-hash:<43 base64url chars>');
  }
  return [...new Set(items)];
}

/** Every origin a WebAuthn response is accepted from: the web app first. */
export function expectedPasskeyOrigins(env: { PUBLIC_ORIGIN: string; PASSKEY_ANDROID_ORIGINS: string[] }): string[] {
  return [env.PUBLIC_ORIGIN, ...env.PASSKEY_ANDROID_ORIGINS];
}

/** android:apk-key-hash origin for a certificate fingerprint as keytool prints it (AA:BB:...). */
export function androidOriginFromFingerprint(sha256: string): string {
  const hex = sha256.replace(/:/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('expected a SHA-256 fingerprint');
  return `android:apk-key-hash:${Buffer.from(hex, 'hex').toString('base64url')}`;
}
