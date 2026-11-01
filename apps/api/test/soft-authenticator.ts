import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software passkey (WebAuthn authenticator) for tests.
 *
 * It does what a phone or security key does, with real cryptography: makes
 * a P-256 key pair, builds the attestation object and authenticator data
 * byte for byte as the WebAuthn spec lays them out, and signs assertions.
 * The server verifies them with @simplewebauthn/server exactly as it would
 * a browser's, so these tests run the whole passkey ceremony end to end.
 */

const b64url = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

// --- minimal CBOR encoder (only what WebAuthn needs) ------------------------
type Cbor = number | string | Buffer | Map<Cbor, Cbor> | { [k: string]: Cbor };
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

export interface SoftAuthenticatorOptions {
  origin: string;
  /** Pretend the user was not verified (no PIN / biometric). */
  skipUserVerification?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;

  constructor(private readonly opts: SoftAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private flags(attested: boolean): number {
    let f = 0x01; // UP: user present
    if (!this.opts.skipUserVerification) f |= 0x04; // UV: user verified
    if (attested) f |= 0x40; // AT: attested credential data follows
    return f;
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return cbor(new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]));
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.opts.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** navigator.credentials.create(), as JSON the server accepts. */
  register(options: { challenge: string; rp: { id: string } }, overrides: { origin?: string; rpId?: string } = {}) {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? options.rp.id), Buffer.from([this.flags(true)]), counter,
      Buffer.alloc(16), // AAGUID: zeros, as with attestation "none"
      idLen, this.credentialId, this.coseKey(),
    ]);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, overrides.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get(), as JSON the server accepts. */
  authenticate(options: { challenge: string; rpId: string }, overrides: { origin?: string; counter?: number; signWith?: SoftAuthenticator } = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([this.flags(false)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides.origin);
    const signer = overrides.signWith ?? this;
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), signer.privateKey);
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature) },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }
}
