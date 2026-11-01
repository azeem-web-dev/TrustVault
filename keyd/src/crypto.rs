//! The only code that ever touches the master key.
//!
//! Two keys are derived from the 32-byte master key with HKDF-SHA256, using
//! different "info" labels so they can never be confused:
//!   - a wrapping key (AES-256-GCM) for per-file data keys and TOTP secrets
//!   - an Ed25519 signing key for audit checkpoints
//! The same labels are used by the API's LocalKeyProvider, so the design is
//! identical in development; only the location of the key differs.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use zeroize::Zeroizing;

pub const WRAP_KEY_ID: &str = "keyd-wrap-v1";
pub const SIGN_KEY_ID: &str = "keyd-ed25519-v1";

pub struct Keys {
    wrap: Aes256Gcm,
    sign: SigningKey,
}

impl Keys {
    pub fn from_master(master: &[u8]) -> Result<Self, String> {
        if master.len() != 32 {
            return Err(format!("master key must be 32 bytes, got {}", master.len()));
        }
        let hk = Hkdf::<Sha256>::new(None, master);
        let mut wrap_key = Zeroizing::new([0u8; 32]);
        hk.expand(b"tv-wrap-v1", wrap_key.as_mut()).map_err(|_| "hkdf failed")?;
        let mut seed = Zeroizing::new([0u8; 32]);
        hk.expand(b"tv-audit-sign-v1", seed.as_mut()).map_err(|_| "hkdf failed")?;
        Ok(Keys {
            wrap: Aes256Gcm::new_from_slice(wrap_key.as_ref()).map_err(|_| "bad wrap key")?,
            sign: SigningKey::from_bytes(&seed),
        })
    }

    /// AES-256-GCM. Output layout: nonce(12) || tag(16) || ciphertext.
    pub fn wrap(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ct_and_tag = self
            .wrap
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
            .map_err(|_| "encrypt failed")?;
        let (ct, tag) = ct_and_tag.split_at(ct_and_tag.len() - 16);
        let mut out = Vec::with_capacity(12 + 16 + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(tag);
        out.extend_from_slice(ct);
        Ok(out)
    }

    pub fn unwrap(&self, sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        if sealed.len() < 28 {
            return Err("sealed value too short".into());
        }
        let (nonce, rest) = sealed.split_at(12);
        let (tag, ct) = rest.split_at(16);
        let mut ct_and_tag = Vec::with_capacity(ct.len() + 16);
        ct_and_tag.extend_from_slice(ct);
        ct_and_tag.extend_from_slice(tag);
        self.wrap
            .decrypt(Nonce::from_slice(nonce), Payload { msg: &ct_and_tag, aad })
            .map(Zeroizing::new)
            // One message for every failure: wrong key, wrong aad, tampered bytes.
            .map_err(|_| "unwrap failed".into())
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.sign.sign(message).to_bytes()
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.sign.verifying_key().to_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    fn keys() -> Keys {
        Keys::from_master(&[7u8; 32]).unwrap()
    }

    #[test]
    fn wrap_roundtrip() {
        let k = keys();
        let sealed = k.wrap(b"data key bytes", b"doc|v1").unwrap();
        assert_eq!(&*k.unwrap(&sealed, b"doc|v1").unwrap(), b"data key bytes");
    }

    #[test]
    fn wrong_aad_fails() {
        let k = keys();
        let sealed = k.wrap(b"secret", b"doc-a").unwrap();
        assert!(k.unwrap(&sealed, b"doc-b").is_err());
    }

    #[test]
    fn tampering_fails() {
        let k = keys();
        let mut sealed = k.wrap(b"secret", b"aad").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(k.unwrap(&sealed, b"aad").is_err());
    }

    #[test]
    fn nonces_are_unique() {
        let k = keys();
        assert_ne!(k.wrap(b"x", b"a").unwrap(), k.wrap(b"x", b"a").unwrap());
    }

    #[test]
    fn different_master_cannot_unwrap() {
        let sealed = keys().wrap(b"secret", b"aad").unwrap();
        let other = Keys::from_master(&[8u8; 32]).unwrap();
        assert!(other.unwrap(&sealed, b"aad").is_err());
    }

    #[test]
    fn signatures_verify() {
        let k = keys();
        let sig = Signature::from_bytes(&k.sign(b"tv-checkpoint-v1|5|abcd"));
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&k.public_key()).unwrap();
        assert!(vk.verify(b"tv-checkpoint-v1|5|abcd", &sig).is_ok());
        assert!(vk.verify(b"tv-checkpoint-v1|6|abcd", &sig).is_err());
    }

    #[test]
    fn rejects_short_master() {
        assert!(Keys::from_master(&[1u8; 16]).is_err());
    }
}
