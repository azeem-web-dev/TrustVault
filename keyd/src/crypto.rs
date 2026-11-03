//! The only code that ever touches master keys.
//!
//! Key hierarchy (docs/KEYS.md):
//!
//!   master generation N (32 random bytes; master.key = generation 1,
//!   master-N.key for later generations)
//!     --HKDF "tv-wrap-g<N>-blob"--> AES-256-GCM key id `keyd-g<N>-blob`
//!                                   wraps per-version document data keys
//!     --HKDF "tv-wrap-g<N>-totp"--> AES-256-GCM key id `keyd-g<N>-totp`
//!                                   wraps TOTP secrets
//!   master generation 1 only:
//!     --HKDF "tv-wrap-v1"--------> legacy key id `keyd-wrap-v1` (both classes;
//!                                   unwrap/rewrap only, never used for new wraps)
//!     --HKDF "tv-audit-sign-v1"--> Ed25519 audit checkpoint key
//!     --HKDF "tv-unwrap-ledger-sign-v1"--> Ed25519 key-ledger checkpoint key
//!
//! A wrapped value is bound to its class by both the key (separate HKDF
//! labels) and the AAD prefix, so a TOTP unwrap (which needs no ticket)
//! can never open a document data key, even with a crafted AAD.
//!
//! The same labels are used by the API's LocalKeyProvider, so the design is
//! identical in development; only the location of the key differs.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

pub const LEGACY_WRAP_KEY_ID: &str = "keyd-wrap-v1";
pub const SIGN_KEY_ID: &str = "keyd-ed25519-v1";
pub const LEDGER_SIGN_KEY_ID: &str = "keyd-ledger-ed25519-v1";

pub const BLOB_AAD_PREFIX: &str = "tv-blob-v1|";
pub const TOTP_AAD_PREFIX: &str = "tv-totp-v1|";
/// The Android app's per-(document, person) copy key (view-only): `tv-offline-v1|<doc uuid>|<user uuid>`.
pub const OFFLINE_AAD_PREFIX: &str = "tv-offline-v1|";

/// What a wrapped value protects. Decided from the AAD, never from the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Blob,
    Totp,
    Offline,
}

impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::Blob => "blob",
            Class::Totp => "totp",
            Class::Offline => "offline",
        }
    }
}

/// Canonical lowercase UUID text.
pub fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

pub fn is_canonical_decimal(s: &str) -> bool {
    !s.is_empty() && s.len() <= 19 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

/// `tv-blob-v1|<doc uuid>|<version uuid>|<version no>` or `tv-totp-v1|<user uuid>`.
/// Anything else is refused: keyd only handles these two kinds of secret.
pub fn class_of(aad: &str) -> Result<Class, String> {
    if let Some(rest) = aad.strip_prefix(BLOB_AAD_PREFIX) {
        let p: Vec<&str> = rest.split('|').collect();
        if p.len() == 3 && is_uuid(p[0]) && is_uuid(p[1]) && is_canonical_decimal(p[2]) && p[2] != "0" {
            return Ok(Class::Blob);
        }
        return Err("malformed blob aad".into());
    }
    if let Some(rest) = aad.strip_prefix(TOTP_AAD_PREFIX) {
        if is_uuid(rest) {
            return Ok(Class::Totp);
        }
        return Err("malformed totp aad".into());
    }
    if let Some(rest) = aad.strip_prefix(OFFLINE_AAD_PREFIX) {
        let p: Vec<&str> = rest.split('|').collect();
        if p.len() == 2 && is_uuid(p[0]) && is_uuid(p[1]) {
            return Ok(Class::Offline);
        }
        return Err("malformed offline aad".into());
    }
    Err("unsupported aad".into())
}

pub fn class_key_id(generation: u32, class: Class) -> String {
    format!("keyd-g{generation}-{}", class.name())
}

/// Parses `keyd-g<N>-<class>`; the legacy id is handled separately.
fn parse_key_id(key_id: &str) -> Option<(u32, Class)> {
    let rest = key_id.strip_prefix("keyd-g")?;
    let (n, class) = rest.split_once('-')?;
    if !is_canonical_decimal(n) || n == "0" || n.len() > 4 {
        return None;
    }
    let class = match class {
        "blob" => Class::Blob,
        "totp" => Class::Totp,
        "offline" => Class::Offline,
        _ => return None,
    };
    Some((n.parse().ok()?, class))
}

struct Generation {
    blob: Aes256Gcm,
    totp: Aes256Gcm,
    offline: Aes256Gcm,
}

fn derive(hk: &Hkdf<Sha256>, label: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(label, out.as_mut()).map_err(|_| "hkdf failed")?;
    Ok(out)
}

fn aes(key: &[u8; 32]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key).map_err(|_| "bad key".to_string())
}

pub struct Keys {
    generations: BTreeMap<u32, Generation>,
    legacy: Aes256Gcm,
    current: u32,
    retired: BTreeSet<u32>,
    sign: SigningKey,
    ledger_sign: SigningKey,
}

impl Keys {
    /// One master key (generation 1).
    #[cfg(test)]
    pub fn from_master(master: &[u8]) -> Result<Self, String> {
        let mut m = BTreeMap::new();
        m.insert(1u32, Zeroizing::new(master.to_vec()));
        Keys::from_generations(&m, None, &BTreeSet::new())
    }

    /// `masters[1]` is required: it also derives the signing keys and the
    /// legacy wrapping key. `current` defaults to the highest generation.
    /// Retired generations can no longer unwrap (or be rewrapped from).
    pub fn from_generations(
        masters: &BTreeMap<u32, Zeroizing<Vec<u8>>>,
        current: Option<u32>,
        retired: &BTreeSet<u32>,
    ) -> Result<Self, String> {
        let first = masters.get(&1).ok_or("master key generation 1 (master.key) is required")?;
        let mut generations = BTreeMap::new();
        for (n, m) in masters {
            if m.len() != 32 {
                return Err(format!("master key generation {n} must be 32 bytes, got {}", m.len()));
            }
            let hk = Hkdf::<Sha256>::new(None, m);
            let blob = derive(&hk, format!("tv-wrap-g{n}-blob").as_bytes())?;
            let totp = derive(&hk, format!("tv-wrap-g{n}-totp").as_bytes())?;
            let offline = derive(&hk, format!("tv-wrap-g{n}-offline").as_bytes())?;
            generations.insert(*n, Generation { blob: aes(&blob)?, totp: aes(&totp)?, offline: aes(&offline)? });
        }
        let current = current.unwrap_or_else(|| *masters.keys().last().unwrap());
        if !generations.contains_key(&current) {
            return Err(format!("current generation {current} has no master key"));
        }
        if retired.contains(&current) {
            return Err(format!("current generation {current} cannot be retired"));
        }
        let hk = Hkdf::<Sha256>::new(None, first);
        let legacy = aes(&*derive(&hk, b"tv-wrap-v1")?)?;
        let seed = derive(&hk, b"tv-audit-sign-v1")?;
        let ledger_seed = derive(&hk, b"tv-unwrap-ledger-sign-v1")?;
        Ok(Keys {
            generations,
            legacy,
            current,
            retired: retired.clone(),
            sign: SigningKey::from_bytes(&seed),
            ledger_sign: SigningKey::from_bytes(&ledger_seed),
        })
    }

    pub fn current_generation(&self) -> u32 {
        self.current
    }

    pub fn generations(&self) -> Vec<u32> {
        self.generations.keys().copied().collect()
    }

    pub fn retired(&self) -> Vec<u32> {
        self.retired.iter().copied().collect()
    }

    pub fn current_key_id(&self, class: Class) -> String {
        class_key_id(self.current, class)
    }

    /// The cipher for an existing key id, if that key may still open values of `class`.
    fn cipher_for(&self, key_id: &str, class: Class) -> Result<&Aes256Gcm, String> {
        if key_id == LEGACY_WRAP_KEY_ID {
            if class == Class::Offline {
                return Err("unknown key id".into());
            }
            if self.retired.contains(&1) {
                return Err("key id is retired".into());
            }
            return Ok(&self.legacy);
        }
        let (n, c) = parse_key_id(key_id).ok_or("unknown key id")?;
        if c != class {
            return Err("key id does not match the aad".into());
        }
        if self.retired.contains(&n) {
            return Err("key id is retired".into());
        }
        let g = self.generations.get(&n).ok_or("unknown key id")?;
        Ok(match c {
            Class::Blob => &g.blob,
            Class::Totp => &g.totp,
            Class::Offline => &g.offline,
        })
    }

    /// Wraps with the current generation's key for the AAD's class.
    pub fn wrap(&self, plaintext: &[u8], aad: &str) -> Result<(Vec<u8>, String), String> {
        let class = class_of(aad)?;
        let g = &self.generations[&self.current];
        let c = match class {
            Class::Blob => &g.blob,
            Class::Totp => &g.totp,
            Class::Offline => &g.offline,
        };
        Ok((seal(c, plaintext, aad.as_bytes())?, self.current_key_id(class)))
    }

    pub fn unwrap(&self, key_id: &str, sealed: &[u8], aad: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        let class = class_of(aad)?;
        open(self.cipher_for(key_id, class)?, sealed, aad.as_bytes())
    }

    /// Re-wraps under the current generation without the value ever leaving
    /// this process. Returns None when it already uses the current key.
    pub fn rewrap(&self, key_id: &str, sealed: &[u8], aad: &str) -> Result<Option<(Vec<u8>, String)>, String> {
        let class = class_of(aad)?;
        let plain = open(self.cipher_for(key_id, class)?, sealed, aad.as_bytes())?;
        if key_id == self.current_key_id(class) {
            return Ok(None);
        }
        self.wrap(&plain, aad).map(Some)
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.sign.sign(message).to_bytes()
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.sign.verifying_key().to_bytes()
    }

    pub fn ledger_sign(&self, message: &[u8]) -> [u8; 64] {
        self.ledger_sign.sign(message).to_bytes()
    }

    pub fn ledger_public_key(&self) -> [u8; 32] {
        self.ledger_sign.verifying_key().to_bytes()
    }
}

/// AES-256-GCM. Output layout: nonce(12) || tag(16) || ciphertext.
fn seal(cipher: &Aes256Gcm, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct_and_tag = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| "encrypt failed")?;
    let (ct, tag) = ct_and_tag.split_at(ct_and_tag.len() - 16);
    let mut out = Vec::with_capacity(12 + 16 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(tag);
    out.extend_from_slice(ct);
    Ok(out)
}

fn open(cipher: &Aes256Gcm, sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if sealed.len() < 28 {
        return Err("sealed value too short".into());
    }
    let (nonce, rest) = sealed.split_at(12);
    let (tag, ct) = rest.split_at(16);
    let mut ct_and_tag = Vec::with_capacity(ct.len() + 16);
    ct_and_tag.extend_from_slice(ct);
    ct_and_tag.extend_from_slice(tag);
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: &ct_and_tag, aad })
        .map(Zeroizing::new)
        // One message for every failure: wrong key, wrong aad, tampered bytes.
        .map_err(|_| "unwrap failed".into())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    pub const DOC: &str = "11111111-1111-4111-8111-111111111111";
    pub const VER: &str = "22222222-2222-4222-8222-222222222222";
    pub const USER: &str = "33333333-3333-4333-8333-333333333333";

    pub fn blob_aad() -> String {
        format!("{BLOB_AAD_PREFIX}{DOC}|{VER}|1")
    }

    fn keys() -> Keys {
        Keys::from_master(&[7u8; 32]).unwrap()
    }

    fn two_generations(current: Option<u32>, retired: &[u32]) -> Keys {
        let mut m = BTreeMap::new();
        m.insert(1, Zeroizing::new(vec![7u8; 32]));
        m.insert(2, Zeroizing::new(vec![9u8; 32]));
        Keys::from_generations(&m, current, &retired.iter().copied().collect()).unwrap()
    }

    /// The pre-generation wrap (key id keyd-wrap-v1), for compatibility tests.
    pub fn legacy_wrap(master: &[u8; 32], plain: &[u8], aad: &str) -> Vec<u8> {
        let hk = Hkdf::<Sha256>::new(None, master);
        let k = derive(&hk, b"tv-wrap-v1").unwrap();
        seal(&aes(&k).unwrap(), plain, aad.as_bytes()).unwrap()
    }

    #[test]
    fn wrap_roundtrip_uses_class_key() {
        let k = keys();
        let (sealed, id) = k.wrap(b"data key bytes", &blob_aad()).unwrap();
        assert_eq!(id, "keyd-g1-blob");
        assert_eq!(&*k.unwrap(&id, &sealed, &blob_aad()).unwrap(), b"data key bytes");
        let (_, tid) = k.wrap(b"x", &format!("{TOTP_AAD_PREFIX}{USER}")).unwrap();
        assert_eq!(tid, "keyd-g1-totp");
    }

    #[test]
    fn legacy_values_still_open() {
        let sealed = legacy_wrap(&[7u8; 32], b"old", &blob_aad());
        assert_eq!(&*keys().unwrap(LEGACY_WRAP_KEY_ID, &sealed, &blob_aad()).unwrap(), b"old");
    }

    #[test]
    fn class_confusion_refused() {
        let k = keys();
        let (sealed, _) = k.wrap(b"dek", &blob_aad()).unwrap();
        assert!(k.unwrap("keyd-g1-totp", &sealed, &blob_aad()).is_err());
        let totp_aad = format!("{TOTP_AAD_PREFIX}{USER}");
        assert!(k.unwrap("keyd-g1-totp", &sealed, &totp_aad).is_err());
    }

    #[test]
    fn unsupported_or_malformed_aad_refused() {
        let k = keys();
        let bad = [
            "a".to_string(),
            "tv-blob-v1|x|y|1".to_string(),
            format!("{BLOB_AAD_PREFIX}{DOC}|{VER}|01"),
            format!("{BLOB_AAD_PREFIX}{DOC}|{VER}|0"),
            format!("{BLOB_AAD_PREFIX}{DOC}|{VER}|1|x"),
            format!("{TOTP_AAD_PREFIX}AAAAAAAA-3333-4333-8333-333333333333"),
        ];
        for aad in bad {
            assert!(k.wrap(b"x", &aad).is_err(), "{aad}");
        }
    }

    #[test]
    fn wrong_aad_fails() {
        let k = keys();
        let (sealed, id) = k.wrap(b"secret", &blob_aad()).unwrap();
        assert!(k.unwrap(&id, &sealed, &format!("{BLOB_AAD_PREFIX}{DOC}|{VER}|2")).is_err());
    }

    #[test]
    fn tampering_fails() {
        let k = keys();
        let (mut sealed, id) = k.wrap(b"secret", &blob_aad()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(k.unwrap(&id, &sealed, &blob_aad()).is_err());
    }

    #[test]
    fn nonces_are_unique() {
        let k = keys();
        assert_ne!(k.wrap(b"x", &blob_aad()).unwrap().0, k.wrap(b"x", &blob_aad()).unwrap().0);
    }

    #[test]
    fn different_master_cannot_unwrap() {
        let (sealed, id) = keys().wrap(b"secret", &blob_aad()).unwrap();
        assert!(Keys::from_master(&[8u8; 32]).unwrap().unwrap(&id, &sealed, &blob_aad()).is_err());
    }

    #[test]
    fn rotation_rewraps_to_current_generation() {
        let (sealed, id) = keys().wrap(b"dek", &blob_aad()).unwrap();
        let legacy = legacy_wrap(&[7u8; 32], b"dek", &blob_aad());
        let k = two_generations(None, &[]);
        assert_eq!(k.current_generation(), 2);
        let (new_sealed, new_id) = k.rewrap(&id, &sealed, &blob_aad()).unwrap().unwrap();
        assert_eq!(new_id, "keyd-g2-blob");
        assert_eq!(&*k.unwrap(&new_id, &new_sealed, &blob_aad()).unwrap(), b"dek");
        let (l2, lid) = k.rewrap(LEGACY_WRAP_KEY_ID, &legacy, &blob_aad()).unwrap().unwrap();
        assert_eq!(lid, "keyd-g2-blob");
        assert_eq!(&*k.unwrap(&lid, &l2, &blob_aad()).unwrap(), b"dek");
        assert!(k.rewrap(&new_id, &new_sealed, &blob_aad()).unwrap().is_none(), "idempotent");
        // The new master alone cannot open what the old one wrapped.
        let mut only_new = BTreeMap::new();
        only_new.insert(1, Zeroizing::new(vec![9u8; 32]));
        let fresh = Keys::from_generations(&only_new, None, &BTreeSet::new()).unwrap();
        assert!(fresh.unwrap("keyd-g1-blob", &sealed, &blob_aad()).is_err());
    }

    #[test]
    fn retired_generation_cannot_unwrap() {
        let (sealed, id) = keys().wrap(b"dek", &blob_aad()).unwrap();
        let legacy = legacy_wrap(&[7u8; 32], b"dek", &blob_aad());
        let k = two_generations(Some(2), &[1]);
        assert!(k.unwrap(&id, &sealed, &blob_aad()).unwrap_err().contains("retired"));
        assert!(k.unwrap(LEGACY_WRAP_KEY_ID, &legacy, &blob_aad()).unwrap_err().contains("retired"));
        assert!(k.rewrap(&id, &sealed, &blob_aad()).is_err());
        let mut m = BTreeMap::new();
        m.insert(1, Zeroizing::new(vec![7u8; 32]));
        assert!(Keys::from_generations(&m, Some(1), &[1].into_iter().collect()).is_err(), "cannot retire the current generation");
    }

    #[test]
    fn key_ids_parse_strictly() {
        let k = keys();
        let (sealed, _) = k.wrap(b"dek", &blob_aad()).unwrap();
        for id in ["keyd-g01-blob", "keyd-g0-blob", "keyd-g1-Blob", "keyd-g1-blob-", "keyd-g9-blob", "local-v1", "keyd-g99999-blob"] {
            assert!(k.unwrap(id, &sealed, &blob_aad()).is_err(), "{id}");
        }
    }

    #[test]
    fn signatures_verify_and_keys_are_distinct() {
        let k = keys();
        let sig = Signature::from_bytes(&k.sign(b"tv-checkpoint-v1|5|abcd"));
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&k.public_key()).unwrap();
        assert!(vk.verify(b"tv-checkpoint-v1|5|abcd", &sig).is_ok());
        assert!(vk.verify(b"tv-checkpoint-v1|6|abcd", &sig).is_err());
        assert_ne!(k.public_key(), k.ledger_public_key());
        let lsig = Signature::from_bytes(&k.ledger_sign(b"m"));
        assert!(ed25519_dalek::VerifyingKey::from_bytes(&k.ledger_public_key()).unwrap().verify(b"m", &lsig).is_ok());
    }

    #[test]
    fn rejects_short_master() {
        assert!(Keys::from_master(&[1u8; 16]).is_err());
    }
}
