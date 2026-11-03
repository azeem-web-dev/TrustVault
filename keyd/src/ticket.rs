//! Unwrap tickets: keyd's own authorisation check for document data keys.
//!
//! The API cannot ask keyd to unwrap a document data key on its own say-so.
//! It must present a ticket minted by the database function
//! tv_issue_unwrap_ticket(), which runs as the schema owner and
//!   - checks the caller's access level with tv_doc_level() for the action,
//!   - requires a fresh ALLOWED audit event for exactly that user, document,
//!     version and action (each event can back one ticket only),
//!   - MACs the ticket with a secret the application role cannot read.
//! keyd holds the same secret (systemd credential ticket.key) and checks
//! the MAC, the expiry, single use, and that the wrapped key and AAD it is
//! asked to open are the ones the ticket names.
//!
//! Wire format (one line, '|' separated, every field strictly parsed):
//!   tv-unwrap-ticket-v1|kid|tid|action|doc|ver|user|aad_sha256|wk_sha256|audit_id|audit_seq|iat|exp|mac
//! mac = hex(HMAC-SHA256(ticket key, everything before "|mac")).
//! kid = first 16 hex of SHA-256("tv-ticket-kid-v1|" || key).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use zeroize::Zeroizing;

use crate::crypto::{is_canonical_decimal, is_uuid};

pub const PREFIX: &str = "tv-unwrap-ticket-v1";
/// A ticket lives at most this long (seconds).
pub const MAX_TTL: u64 = 60;
/// Tolerated clock difference between the database and keyd (same host).
pub const MAX_SKEW: u64 = 5;
/// Actions with no user behind them. Everything else must name a user.
pub const SYSTEM_ACTIONS: &[&str] = &["rescan", "reencrypt"];

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub kid: String,
    pub tid: String,
    pub action: String,
    pub doc: String,
    pub ver: String,
    /// None for system actions.
    pub user: Option<String>,
    pub aad_sha256: String,
    pub wk_sha256: String,
    pub audit_id: String,
    pub audit_seq: u64,
    pub iat: u64,
    pub exp: u64,
}

pub fn kid_of(key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"tv-ticket-kid-v1|");
    h.update(key);
    hex(&h.finalize())[..16].to_string()
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_action(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn num(s: &str) -> Result<u64, String> {
    if !is_canonical_decimal(s) {
        return Err("malformed ticket".into());
    }
    s.parse().map_err(|_| "malformed ticket".into())
}

/// The secrets tickets are MACed with, by kid. Normally one; two while the
/// ticket key is being rotated.
pub struct TicketKeys {
    keys: HashMap<String, Zeroizing<Vec<u8>>>,
}

impl TicketKeys {
    pub fn new(keys: Vec<Zeroizing<Vec<u8>>>) -> Result<Self, String> {
        let mut m = HashMap::new();
        for k in keys {
            if k.len() != 32 {
                return Err(format!("ticket key must be 32 bytes, got {}", k.len()));
            }
            m.insert(kid_of(&k), k);
        }
        Ok(TicketKeys { keys: m })
    }

    pub fn kids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.keys.keys().cloned().collect();
        v.sort();
        v
    }

    /// Test and LocalKeyProvider-compatibility helper: mints a ticket.
    #[cfg(test)]
    pub fn mint(&self, t: &Ticket) -> String {
        let body = body(t);
        let key = &self.keys[&t.kid];
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(body.as_bytes());
        format!("{body}|{}", hex(&mac.finalize().into_bytes()))
    }

    /// Strict parse + MAC check. Says nothing about expiry, replay or binding.
    pub fn verify_mac(&self, s: &str) -> Result<Ticket, String> {
        if s.len() > 1024 {
            return Err("malformed ticket".into());
        }
        let parts: Vec<&str> = s.split('|').collect();
        if parts.len() != 14 || parts[0] != PREFIX {
            return Err("malformed ticket".into());
        }
        let (body, mac_hex) = s.rsplit_once('|').ok_or("malformed ticket")?;
        let kid = parts[1];
        let key = self.keys.get(kid).ok_or("unknown ticket key")?;
        if !is_hex64(mac_hex) {
            return Err("malformed ticket".into());
        }
        let mac_bytes = unhex(mac_hex).ok_or("malformed ticket")?;
        let mut mac = HmacSha256::new_from_slice(key).map_err(|_| "bad ticket key")?;
        mac.update(body.as_bytes());
        // Constant-time comparison.
        mac.verify_slice(&mac_bytes).map_err(|_| "bad ticket mac")?;

        let user = match parts[6] {
            "-" => None,
            u if is_uuid(u) => Some(u.to_string()),
            _ => return Err("malformed ticket".into()),
        };
        let t = Ticket {
            kid: kid.to_string(),
            tid: parts[2].to_string(),
            action: parts[3].to_string(),
            doc: parts[4].to_string(),
            ver: parts[5].to_string(),
            user,
            aad_sha256: parts[7].to_string(),
            wk_sha256: parts[8].to_string(),
            audit_id: parts[9].to_string(),
            audit_seq: num(parts[10])?,
            iat: num(parts[11])?,
            exp: num(parts[12])?,
        };
        if !is_uuid(&t.tid) || !is_uuid(&t.doc) || !is_uuid(&t.ver) || !is_uuid(&t.audit_id) {
            return Err("malformed ticket".into());
        }
        if !is_action(&t.action) || !is_hex64(&t.aad_sha256) || !is_hex64(&t.wk_sha256) || t.audit_seq == 0 {
            return Err("malformed ticket".into());
        }
        let system = SYSTEM_ACTIONS.contains(&t.action.as_str());
        if system != t.user.is_none() {
            return Err("ticket user does not fit its action".into());
        }
        Ok(t)
    }
}

#[cfg(test)]
pub fn body(t: &Ticket) -> String {
    format!(
        "{PREFIX}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        t.kid,
        t.tid,
        t.action,
        t.doc,
        t.ver,
        t.user.as_deref().unwrap_or("-"),
        t.aad_sha256,
        t.wk_sha256,
        t.audit_id,
        t.audit_seq,
        t.iat,
        t.exp
    )
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// Time and binding checks, separate from the MAC so each is testable.
pub fn check_binding(t: &Ticket, now: u64, aad: &str, wrapped: &[u8]) -> Result<(), String> {
    if t.exp <= t.iat || t.exp - t.iat > MAX_TTL {
        return Err("ticket lifetime too long".into());
    }
    if t.iat > now + MAX_SKEW {
        return Err("ticket issued in the future".into());
    }
    if now >= t.exp {
        return Err("ticket expired".into());
    }
    // The AAD names the document and version; it must be the ticket's. A
    // copy-key ticket opens exactly that person's key for that document.
    let own = if t.action == "offline_key" {
        match &t.user {
            Some(u) => aad == format!("{}{}|{}", crate::crypto::OFFLINE_AAD_PREFIX, t.doc, u),
            None => false,
        }
    } else {
        aad.starts_with(&format!("{}{}|{}|", crate::crypto::BLOB_AAD_PREFIX, t.doc, t.ver))
    };
    if !own {
        return Err("ticket is for another document version".into());
    }
    if sha256_hex(aad.as_bytes()) != t.aad_sha256 {
        return Err("ticket is for another document version".into());
    }
    if sha256_hex(wrapped) != t.wk_sha256 {
        return Err("ticket is for another wrapped key".into());
    }
    Ok(())
}

/// Ticket ids seen recently. A ticket can only be used once; entries are
/// dropped after they could no longer pass the expiry check anyway.
pub struct ReplayCache {
    seen: Mutex<HashMap<String, u64>>,
}

impl ReplayCache {
    pub fn new() -> Self {
        ReplayCache { seen: Mutex::new(HashMap::new()) }
    }

    /// Records `tid` (kept until `keep_until`); false if it was already used.
    pub fn first_use(&self, tid: &str, keep_until: u64, now: u64) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() > 10_000 {
            seen.retain(|_, until| *until > now);
        }
        if seen.contains_key(tid) {
            return false;
        }
        seen.insert(tid.to_string(), keep_until);
        true
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::crypto::tests::{blob_aad, DOC, USER, VER};

    pub const KEY: [u8; 32] = [5u8; 32];
    pub const NOW: u64 = 1_800_000_000;

    pub fn keys() -> TicketKeys {
        TicketKeys::new(vec![Zeroizing::new(KEY.to_vec())]).unwrap()
    }

    pub fn ticket(wrapped: &[u8]) -> Ticket {
        Ticket {
            kid: kid_of(&KEY),
            tid: "44444444-4444-4444-8444-444444444444".into(),
            action: "download".into(),
            doc: DOC.into(),
            ver: VER.into(),
            user: Some(USER.into()),
            aad_sha256: sha256_hex(blob_aad().as_bytes()),
            wk_sha256: sha256_hex(wrapped),
            audit_id: "55555555-5555-4555-8555-555555555555".into(),
            audit_seq: 42,
            iat: NOW,
            exp: NOW + 30,
        }
    }

    #[test]
    fn valid_ticket_verifies() {
        let k = keys();
        let t = ticket(b"wk");
        let s = k.mint(&t);
        assert_eq!(k.verify_mac(&s).unwrap(), t);
        assert!(check_binding(&t, NOW + 1, &blob_aad(), b"wk").is_ok());
    }

    #[test]
    fn forged_or_altered_tickets_fail() {
        let k = keys();
        let s = k.mint(&ticket(b"wk"));
        // Any change to any field breaks the MAC.
        let other = s.replace(DOC, "66666666-6666-4666-8666-666666666666");
        assert_eq!(k.verify_mac(&other).unwrap_err(), "bad ticket mac");
        let longer = s.replace(&format!("|{}|", NOW + 30), &format!("|{}|", NOW + 3600));
        assert_eq!(k.verify_mac(&longer).unwrap_err(), "bad ticket mac");
        // A ticket MACed with another secret (an attacker's guess).
        let attacker = TicketKeys::new(vec![Zeroizing::new(vec![6u8; 32])]).unwrap();
        let mut t = ticket(b"wk");
        t.kid = kid_of(&[6u8; 32]);
        assert_eq!(k.verify_mac(&attacker.mint(&t)).unwrap_err(), "unknown ticket key");
        // Same kid claimed, wrong secret: MAC fails.
        let forged = attacker.mint(&t).replacen(&kid_of(&[6u8; 32]), &kid_of(&KEY), 1);
        assert_eq!(k.verify_mac(&forged).unwrap_err(), "bad ticket mac");
    }

    #[test]
    fn malformed_tickets_refused() {
        let k = keys();
        let s = k.mint(&ticket(b"wk"));
        let bad = vec![
            String::new(),
            "tv-unwrap-ticket-v1".into(),
            s.replace("tv-unwrap-ticket-v1", "tv-unwrap-ticket-v2"),
            format!("{s}|extra"),
            s[..s.len() - 1].to_string(),
            s.to_uppercase(),
            "x".repeat(2000),
        ];
        for b in bad {
            assert!(k.verify_mac(&b).is_err(), "{b}");
        }
    }

    #[test]
    fn user_and_action_must_fit() {
        let k = keys();
        let mut t = ticket(b"wk");
        t.user = None; // a download with no user
        assert!(k.verify_mac(&k.mint(&t)).is_err());
        let mut r = ticket(b"wk");
        r.action = "rescan".into(); // a system action naming a user
        assert!(k.verify_mac(&k.mint(&r)).is_err());
        r.user = None;
        assert!(k.verify_mac(&k.mint(&r)).is_ok());
        let mut bad = ticket(b"wk");
        bad.action = "Download".into();
        assert!(k.verify_mac(&k.mint(&bad)).is_err());
    }

    #[test]
    fn expiry_and_lifetime() {
        let t = ticket(b"wk");
        assert_eq!(check_binding(&t, NOW + 30, &blob_aad(), b"wk").unwrap_err(), "ticket expired");
        assert_eq!(check_binding(&t, NOW + 1000, &blob_aad(), b"wk").unwrap_err(), "ticket expired");
        assert_eq!(check_binding(&t, NOW - 10, &blob_aad(), b"wk").unwrap_err(), "ticket issued in the future");
        let mut long = ticket(b"wk");
        long.exp = NOW + MAX_TTL + 1;
        assert_eq!(check_binding(&long, NOW, &blob_aad(), b"wk").unwrap_err(), "ticket lifetime too long");
        let mut backwards = ticket(b"wk");
        backwards.exp = NOW;
        assert!(check_binding(&backwards, NOW, &blob_aad(), b"wk").is_err());
    }

    #[test]
    fn ticket_for_doc_a_cannot_open_doc_b() {
        let t = ticket(b"wk-a");
        let aad_b = format!("tv-blob-v1|66666666-6666-4666-8666-666666666666|{VER}|1");
        assert_eq!(check_binding(&t, NOW, &aad_b, b"wk-a").unwrap_err(), "ticket is for another document version");
        // Same document, other version number in the AAD.
        assert!(check_binding(&t, NOW, &format!("tv-blob-v1|{DOC}|{VER}|2"), b"wk-a").is_err());
        // Right AAD, someone else's wrapped key.
        assert_eq!(check_binding(&t, NOW, &blob_aad(), b"wk-b").unwrap_err(), "ticket is for another wrapped key");
    }

    #[test]
    fn replay_cache_allows_once() {
        let c = ReplayCache::new();
        assert!(c.first_use("a", NOW + 60, NOW));
        assert!(!c.first_use("a", NOW + 60, NOW));
        assert!(c.first_use("b", NOW + 60, NOW));
    }

    /// Minted by the database (tv_hmac_sha256 in migration 20261103400000)
    /// with key [5; 32]: keyd must accept exactly what Postgres produces.
    pub const DB_VECTOR: &str = "tv-unwrap-ticket-v1|2be527e44cdf6898|44444444-4444-4444-8444-444444444444|download|11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222|33333333-3333-4333-8333-333333333333|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|55555555-5555-4555-8555-555555555555|42|1800000000|1800000030|7d6d9da05d1c103b2683c0d957bc7b24d0c77b0e2c901a8ba266b1d8b085f567";

    #[test]
    fn accepts_a_ticket_minted_by_the_database() {
        assert_eq!(kid_of(&KEY), "2be527e44cdf6898");
        let t = keys().verify_mac(DB_VECTOR).unwrap();
        assert_eq!((t.action.as_str(), t.audit_seq, t.iat, t.exp), ("download", 42, 1_800_000_000, 1_800_000_030));
        let mut flipped = DB_VECTOR.to_string();
        flipped.replace_range(flipped.len() - 1.., "6");
        assert_eq!(keys().verify_mac(&flipped).unwrap_err(), "bad ticket mac");
    }

    #[test]
    fn two_ticket_keys_during_rotation() {
        let k = TicketKeys::new(vec![Zeroizing::new(KEY.to_vec()), Zeroizing::new(vec![6u8; 32])]).unwrap();
        assert_eq!(k.kids().len(), 2);
        let mut t = ticket(b"wk");
        assert!(k.verify_mac(&k.mint(&t)).is_ok());
        t.kid = kid_of(&[6u8; 32]);
        assert!(k.verify_mac(&k.mint(&t)).is_ok());
        assert!(TicketKeys::new(vec![Zeroizing::new(vec![1u8; 16])]).is_err());
    }
}
