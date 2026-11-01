import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import { createConnection } from 'node:net';

/**
 * Everything that needs a long-lived secret goes through a KeyProvider:
 * wrapping per-file data keys, wrapping TOTP secrets, and signing audit
 * checkpoints. In production this is `keyd`, a separate process running
 * as a different Linux user, so the API never holds the master key. The
 * local provider exists for development and tests only.
 */
export interface KeyProvider {
  /** Encrypts a small secret (a data key) bound to `aad`. */
  wrap(plaintext: Buffer, aad: string): Promise<{ wrapped: Buffer; keyId: string }>;
  unwrap(wrapped: Buffer, keyId: string, aad: string): Promise<Buffer>;
  /** Ed25519 signature over `message`. */
  sign(message: Buffer): Promise<{ signature: Buffer; keyId: string }>;
  /** Raw 32-byte Ed25519 public key, published so anyone can verify checkpoints. */
  publicKey(): Promise<{ publicKey: Buffer; keyId: string }>;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

// PKCS#8 / SPKI DER prefixes for raw Ed25519 keys.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** AES-256-GCM: output is nonce(12) || tag(16) || ciphertext. */
export function aesGcmSeal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

export function aesGcmOpen(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 28) throw new Error('sealed value too short');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

/**
 * Development/test provider. Derives a wrapping key and a signing key from
 * one master key with HKDF (separate "info" labels, so the two can never be
 * confused). Refused in production — see loadEnv().
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly wrapKey: Buffer;
  private readonly signKey: KeyObject;
  private readonly pub: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('LOCAL_MASTER_KEY must be 32 bytes');
    this.wrapKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tv-wrap-v1', 32));
    const seed = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tv-audit-sign-v1', 32));
    this.signKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(this.signKey).export({ format: 'der', type: 'spki' });
    this.pub = Buffer.from(spki.subarray(spki.length - 32));
  }

  async wrap(plaintext: Buffer, aad: string) {
    return { wrapped: aesGcmSeal(this.wrapKey, plaintext, aad), keyId: 'local-v1' };
  }

  async unwrap(wrapped: Buffer, keyId: string, aad: string) {
    if (keyId !== 'local-v1') throw new Error(`unknown key id ${keyId}`);
    return aesGcmOpen(this.wrapKey, wrapped, aad);
  }

  async sign(message: Buffer) {
    return { signature: edSign(null, message, this.signKey), keyId: 'local-ed25519-v1' };
  }

  async publicKey() {
    return { publicKey: this.pub, keyId: 'local-ed25519-v1' };
  }
}

/**
 * Talks to keyd over a Unix socket: one JSON request per line, one JSON
 * response per line. The socket is only accessible to the trustvault group,
 * and keyd additionally checks the peer's uid (SO_PEERCRED).
 */
export class KeydKeyProvider implements KeyProvider {
  constructor(private readonly socketPath: string) {}

  private call(req: Record<string, string>): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('keyd timeout'));
      }, 5000);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > 1_000_000) {
          sock.destroy();
          reject(new Error('keyd response too large'));
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          sock.end();
          try {
            const res = JSON.parse(buf.slice(0, nl)) as Record<string, string>;
            if (res.error) reject(new Error(`keyd: ${res.error}`));
            else resolve(res);
          } catch (err) {
            reject(err);
          }
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async wrap(plaintext: Buffer, aad: string) {
    const r = await this.call({ op: 'wrap', aad, data: plaintext.toString('base64') });
    return { wrapped: Buffer.from(r.data!, 'base64'), keyId: r.key_id! };
  }

  async unwrap(wrapped: Buffer, keyId: string, aad: string) {
    const r = await this.call({ op: 'unwrap', aad, key_id: keyId, data: wrapped.toString('base64') });
    return Buffer.from(r.data!, 'base64');
  }

  async sign(message: Buffer) {
    const r = await this.call({ op: 'sign', data: message.toString('base64') });
    return { signature: Buffer.from(r.signature!, 'base64'), keyId: r.key_id! };
  }

  async publicKey() {
    const r = await this.call({ op: 'pubkey' });
    return { publicKey: Buffer.from(r.public_key!, 'base64'), keyId: r.key_id! };
  }
}
