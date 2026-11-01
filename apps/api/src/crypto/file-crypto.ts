import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

export interface SealedFile {
  wrappedKey: Buffer;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Binds a ciphertext to the exact document version it belongs to. Moving
 * an encrypted blob to another row (even with database write access) makes
 * decryption fail instead of serving the wrong file.
 */
export const blobAad = (documentId: string, versionId: string, versionNo: number): string =>
  `tv-blob-v1|${documentId}|${versionId}|${versionNo}`;

export const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

/** Envelope encryption: a fresh random 256-bit data key per version, wrapped by the key provider. */
export async function sealFile(keys: KeyProvider, plaintext: Buffer, aad: string): Promise<SealedFile> {
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const { wrapped, keyId } = await keys.wrap(dataKey, aad);
    return { wrappedKey: wrapped, keyId, nonce, authTag: cipher.getAuthTag(), ciphertext };
  } finally {
    dataKey.fill(0);
  }
}

export async function openFile(keys: KeyProvider, sealed: SealedFile, aad: string): Promise<Buffer> {
  const dataKey = await keys.unwrap(sealed.wrappedKey, sealed.keyId, aad);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } finally {
    dataKey.fill(0);
  }
}
