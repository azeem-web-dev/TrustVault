//! keyd's own append-only, hash-chained record of key use.
//!
//! Every document data-key unwrap (and every refusal, every TOTP unwrap,
//! every rewrap, every keyd start) is appended here BEFORE any key leaves
//! this process. The file lives in keyd's StateDirectory (0700, tvkeyd
//! only): the API user can neither read nor write it. The API can only ask
//! for entries (ledger_read) and for a signed head (ledger_head), signed
//! with an Ed25519 key that is derived for this purpose only.
//!
//! Entry hash = SHA-256(prev hash || canonical bytes), canonical bytes being
//! length-prefixed fields in a fixed order (same encoding as the audit log:
//! NULL -> "~", value -> "<utf8 byte length>:<value>"). The first entry's
//! prev hash is 32 zero bytes. tools/reconcile-ledger.mjs and the API
//! recompute the same chain.
//!
//! What this does NOT protect against: root (or anyone holding the master
//! key) can rewrite this file and re-sign a head. Heads that were already
//! published (Rekor / witness) then no longer match; heads not yet
//! published can be rewritten silently. See THREATS.md K-rows.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::ticket::hex;

pub const FORMAT: &str = "tv-unwrap-ledger-v1";
const INDEX_EVERY: u64 = 256;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    pub seq: u64,
    /// Unix milliseconds.
    pub ts: u64,
    /// unwrap | refuse | totp_unwrap | rewrap | start
    pub event: String,
    pub action: Option<String>,
    pub tid: Option<String>,
    pub user: Option<String>,
    pub doc: Option<String>,
    pub ver: Option<String>,
    pub audit_id: Option<String>,
    pub audit_seq: Option<u64>,
    pub key_id: Option<String>,
    pub aad_sha256: Option<String>,
    /// "ok" or the refusal / failure reason.
    pub result: String,
    pub detail: Option<String>,
    pub prev: String,
    pub hash: String,
}

fn field(out: &mut Vec<u8>, v: Option<&str>) {
    match v {
        None => out.push(b'~'),
        Some(s) => {
            out.extend_from_slice(s.len().to_string().as_bytes());
            out.push(b':');
            out.extend_from_slice(s.as_bytes());
        }
    }
}

pub fn canonical(e: &Entry) -> Vec<u8> {
    let mut out = Vec::with_capacity(512);
    field(&mut out, Some(FORMAT));
    field(&mut out, Some(&e.seq.to_string()));
    field(&mut out, Some(&e.ts.to_string()));
    field(&mut out, Some(&e.event));
    field(&mut out, e.action.as_deref());
    field(&mut out, e.tid.as_deref());
    field(&mut out, e.user.as_deref());
    field(&mut out, e.doc.as_deref());
    field(&mut out, e.ver.as_deref());
    field(&mut out, e.audit_id.as_deref());
    field(&mut out, e.audit_seq.map(|s| s.to_string()).as_deref());
    field(&mut out, e.key_id.as_deref());
    field(&mut out, e.aad_sha256.as_deref());
    field(&mut out, Some(&e.result));
    field(&mut out, e.detail.as_deref());
    out
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

pub fn entry_hash(prev: &[u8; 32], e: &Entry) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prev);
    h.update(canonical(e));
    h.finalize().into()
}

/// The message a ledger head signature covers.
pub fn head_message(seq: u64, hash_hex: &str) -> String {
    format!("{FORMAT}|{seq}|{hash_hex}")
}

struct Inner {
    path: Option<PathBuf>,
    file: Option<File>,
    len: u64,
    seq: u64,
    head: [u8; 32],
    /// Memory-only mode (no state directory): all entries.
    mem: Vec<Entry>,
    /// File mode: byte offset of every INDEX_EVERY-th entry (seq 1, 257, ...).
    index: Vec<u64>,
}

pub struct Ledger {
    inner: Mutex<Inner>,
}

impl Ledger {
    /// Opens (or creates) the ledger and verifies the whole chain. A broken
    /// chain is an error: keyd refuses to start rather than continue a
    /// ledger someone has edited. An unterminated last line can only be a
    /// write interrupted by a crash (each entry is fsynced before the key
    /// it records is released), so it is cut off. `visit` sees every entry.
    pub fn open<F: FnMut(&Entry)>(path: Option<PathBuf>, mut visit: F) -> Result<Self, String> {
        let mut inner = Inner { path: path.clone(), file: None, len: 0, seq: 0, head: [0u8; 32], mem: Vec::new(), index: Vec::new() };
        let Some(p) = path else {
            return Ok(Ledger { inner: Mutex::new(inner) });
        };
        let file = OpenOptions::new().read(true).append(true).create(true).mode(0o600).open(&p)
            .map_err(|e| format!("cannot open ledger {}: {e}", p.display()))?;
        let mut reader = BufReader::new(file.try_clone().map_err(|e| e.to_string())?);
        let mut offset: u64 = 0;
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).map_err(|e| format!("cannot read ledger: {e}"))?;
            if n == 0 {
                break;
            }
            if !line.ends_with('\n') {
                crate::log(&format!("ledger: dropping an unterminated last line ({n} bytes) left by an interrupted write"));
                file.set_len(offset).map_err(|e| format!("cannot truncate ledger: {e}"))?;
                break;
            }
            let e: Entry = serde_json::from_str(line.trim_end()).map_err(|_| format!("ledger entry after seq {} is corrupt", inner.seq))?;
            if e.seq != inner.seq + 1 {
                return Err(format!("ledger seq jumps from {} to {}", inner.seq, e.seq));
            }
            if e.prev != hex(&inner.head) {
                return Err(format!("ledger entry {} does not link to the previous entry", e.seq));
            }
            let h = entry_hash(&inner.head, &e);
            if e.hash != hex(&h) {
                return Err(format!("ledger entry {} hash mismatch", e.seq));
            }
            if (e.seq - 1).is_multiple_of(INDEX_EVERY) {
                inner.index.push(offset);
            }
            visit(&e);
            inner.seq = e.seq;
            inner.head = h;
            offset += n as u64;
        }
        inner.len = offset;
        inner.file = Some(file);
        Ok(Ledger { inner: Mutex::new(inner) })
    }

    pub fn head(&self) -> (u64, String) {
        let i = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (i.seq, hex(&i.head))
    }

    /// Appends one entry durably (fsync) and returns it. `e`'s seq, prev
    /// and hash are filled in here.
    pub fn append(&self, mut e: Entry, now_ms: u64) -> Result<Entry, String> {
        let mut i = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        e.seq = i.seq + 1;
        e.ts = now_ms;
        e.prev = hex(&i.head);
        let h = entry_hash(&i.head, &e);
        e.hash = hex(&h);
        let mut line = serde_json::to_string(&e).map_err(|_| "cannot encode ledger entry")?;
        line.push('\n');
        if i.path.is_some() {
            let start = i.len;
            let file = i.file.as_mut().ok_or("ledger is not open")?;
            let res = file.write_all(line.as_bytes()).and_then(|_| file.sync_data());
            if let Err(err) = res {
                // Leave no partial line behind for the next append to extend.
                let _ = file.set_len(start);
                return Err(format!("cannot write ledger: {err}"));
            }
            if (e.seq - 1).is_multiple_of(INDEX_EVERY) {
                i.index.push(start);
            }
            i.len = start + line.len() as u64;
        } else {
            i.mem.push(e.clone());
        }
        i.seq = e.seq;
        i.head = h;
        Ok(e)
    }

    /// Entries with seq >= from, at most `limit`, oldest first.
    pub fn read(&self, from: u64, limit: usize) -> Result<Vec<Entry>, String> {
        let i = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let from = from.max(1);
        if from > i.seq || limit == 0 {
            return Ok(Vec::new());
        }
        if i.path.is_none() {
            return Ok(i.mem.iter().skip((from - 1) as usize).take(limit).cloned().collect());
        }
        let slot = ((from - 1) / INDEX_EVERY) as usize;
        let start = *i.index.get(slot).ok_or("ledger index is incomplete")?;
        let mut f = File::open(i.path.as_ref().unwrap()).map_err(|e| format!("cannot read ledger: {e}"))?;
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let reader = BufReader::new(f.take(i.len - start));
        let mut out = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let e: Entry = serde_json::from_str(&line).map_err(|_| "ledger entry is corrupt")?;
            if e.seq >= from {
                out.push(e);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }
}

/// Recomputes a run of entries against the hash before them. Used by tests;
/// the API and tools/reconcile-ledger.mjs implement the same check.
#[cfg(test)]
pub fn verify_chain(prev_hex: &str, entries: &[Entry]) -> Result<(), String> {
    let mut prev = unhex32(prev_hex).ok_or("bad prev")?;
    for e in entries {
        if e.prev != hex(&prev) {
            return Err(format!("entry {} does not link", e.seq));
        }
        let h = entry_hash(&prev, e);
        if e.hash != hex(&h) {
            return Err(format!("entry {} hash mismatch", e.seq));
        }
        prev = h;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn parse_hash(s: &str) -> Option<[u8; 32]> {
    unhex32(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tvkeyd-ledger-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("unwrap-ledger.jsonl")
    }

    fn entry(event: &str, tid: &str) -> Entry {
        Entry { event: event.into(), tid: Some(tid.into()), result: "ok".into(), action: Some("download".into()), audit_seq: Some(7), ..Default::default() }
    }

    #[test]
    fn chain_links_and_verifies() {
        let l = Ledger::open(None, |_| {}).unwrap();
        for n in 0..5 {
            l.append(entry("unwrap", &format!("t{n}")), 1000 + n).unwrap();
        }
        let all = l.read(1, 100).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].prev, "0".repeat(64));
        verify_chain(&"0".repeat(64), &all).unwrap();
        assert_eq!(l.head(), (5, all[4].hash.clone()));
        assert_eq!(l.read(4, 10).unwrap().len(), 2);
        assert!(l.read(6, 10).unwrap().is_empty());
    }

    #[test]
    fn tampering_is_detected_by_verifier() {
        let l = Ledger::open(None, |_| {}).unwrap();
        for n in 0..3 {
            l.append(entry("unwrap", &format!("t{n}")), 1000).unwrap();
        }
        let mut all = l.read(1, 10).unwrap();
        all[1].user = Some("someone-else".into());
        assert!(verify_chain(&"0".repeat(64), &all).is_err());
        let mut dropped = l.read(1, 10).unwrap();
        dropped.remove(1);
        assert!(verify_chain(&"0".repeat(64), &dropped).is_err());
    }

    #[test]
    fn persists_reopens_and_indexes() {
        let p = tmp("persist");
        {
            let l = Ledger::open(Some(p.clone()), |_| {}).unwrap();
            for n in 0..600 {
                l.append(entry("unwrap", &format!("t{n}")), 1000 + n).unwrap();
            }
        }
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&p).unwrap().permissions()) & 0o777;
        assert_eq!(mode, 0o600);
        let mut seen = 0;
        let l = Ledger::open(Some(p.clone()), |_| seen += 1).unwrap();
        assert_eq!(seen, 600);
        assert_eq!(l.head().0, 600);
        let page = l.read(300, 5).unwrap();
        assert_eq!(page.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![300, 301, 302, 303, 304]);
        assert_eq!(l.read(513, 1).unwrap()[0].tid.as_deref(), Some("t512"));
        l.append(entry("unwrap", "after"), 5000).unwrap();
        assert_eq!(l.read(601, 5).unwrap()[0].tid.as_deref(), Some("after"));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn edited_file_refuses_to_open() {
        let p = tmp("edited");
        {
            let l = Ledger::open(Some(p.clone()), |_| {}).unwrap();
            for n in 0..3 {
                l.append(entry("unwrap", &format!("t{n}")), 1000).unwrap();
            }
        }
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replacen("\"t1\"", "\"tX\"", 1)).unwrap();
        assert!(Ledger::open(Some(p.clone()), |_| {}).err().unwrap().contains("hash mismatch"));
        // Deleting a line breaks the seq.
        let lines: Vec<&str> = text.lines().collect();
        std::fs::write(&p, format!("{}\n{}\n", lines[0], lines[2])).unwrap();
        assert!(Ledger::open(Some(p.clone()), |_| {}).err().unwrap().contains("seq jumps"));
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn interrupted_write_is_cut_off() {
        let p = tmp("partial");
        {
            let l = Ledger::open(Some(p.clone()), |_| {}).unwrap();
            l.append(entry("unwrap", "a"), 1000).unwrap();
        }
        let mut f = OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"seq\":2,\"ts\":").unwrap();
        drop(f);
        let l = Ledger::open(Some(p.clone()), |_| {}).unwrap();
        assert_eq!(l.head().0, 1);
        l.append(entry("unwrap", "b"), 2000).unwrap();
        drop(l);
        let l = Ledger::open(Some(p.clone()), |_| {}).unwrap();
        assert_eq!(l.head().0, 2);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    /// Same entry hashed by tools/reconcile-ledger.mjs and the API (key-ledger.ts).
    #[test]
    fn cross_language_vector() {
        let e = Entry {
            seq: 7, ts: 1_800_000_000_123, event: "unwrap".into(), action: Some("download".into()),
            tid: Some("44444444-4444-4444-8444-444444444444".into()), user: None, doc: Some("d".into()), ver: None,
            audit_id: Some("é".into()), audit_seq: Some(42), key_id: Some("keyd-g1-blob".into()), aad_sha256: None,
            result: "ok".into(), detail: None, prev: String::new(), hash: String::new(),
        };
        assert_eq!(hex(&entry_hash(&[0u8; 32], &e)), "fed2e04dbb295be6a1d85f7776b9e6ccc1b9766a388ca13de65315f6fccee09c");
    }

    #[test]
    fn canonical_encoding_is_unambiguous() {
        let mut a = entry("unwrap", "x");
        let mut b = entry("unwrap", "x");
        a.user = Some("ab".into());
        a.doc = None;
        b.user = Some("a".into());
        b.doc = Some("b".into());
        assert_ne!(canonical(&a), canonical(&b));
        assert_eq!(head_message(3, "ab"), "tv-unwrap-ledger-v1|3|ab");
    }
}
