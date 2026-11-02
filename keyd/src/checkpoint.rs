//! Guard on checkpoint signing.
//!
//! The API asks us to sign `tv-checkpoint-v1|<seq>|<head hash hex>`. A
//! compromised API could otherwise get a checkpoint for an absurd seq (say
//! 2^62) signed; once that is stored, the real checkpoint job thinks the log
//! is already covered and never signs again, leaving every later event
//! unprotected. So:
//!   - the message is parsed strictly (exact prefix, canonical decimal seq,
//!     64 lowercase hex characters for the SHA-256 head hash, nothing else);
//!   - we remember the highest seq ever signed and refuse anything that is
//!     not strictly greater;
//!   - that value is written to disk (0600, atomic rename, fsync) BEFORE the
//!     signature leaves this process, so a restart cannot reset it.
//!
//! The database refuses a checkpoint whose seq/hash do not match a real
//! audit event (migration 20261102190000_checkpoint_guard); this is the
//! second, independent half of the same fix.
//!
//! Known trade-off: a compromised API can still burn the counter forward by
//! asking for a huge seq. That signature can't be stored (the database
//! refuses it), and keyd then refuses honest checkpoints: a loud, visible
//! failure instead of a silent unprotected tail. Recovery is an operator
//! resetting the state file after investigating.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const PREFIX: &str = "tv-checkpoint-v1|";
/// SHA-256 head hash, hex encoded.
const HASH_HEX_LEN: usize = 64;

/// Strictly parses a checkpoint message. Returns its seq.
pub fn parse(msg: &[u8]) -> Result<u64, String> {
    let text = std::str::from_utf8(msg).map_err(|_| "refusing to sign: not a checkpoint")?;
    let rest = text.strip_prefix(PREFIX).ok_or("refusing to sign: not a checkpoint")?;
    let mut parts = rest.split('|');
    let (seq_s, hash_s) = match (parts.next(), parts.next(), parts.next()) {
        (Some(s), Some(h), None) => (s, h),
        _ => return Err("refusing to sign: malformed checkpoint (expected tv-checkpoint-v1|<seq>|<hash>)".into()),
    };
    // Canonical positive decimal: digits only, no sign, no leading zero.
    if seq_s.is_empty() || seq_s.len() > 19 || !seq_s.bytes().all(|b| b.is_ascii_digit()) || seq_s.starts_with('0') {
        return Err("refusing to sign: malformed checkpoint seq".into());
    }
    let seq: u64 = seq_s.parse().map_err(|_| "refusing to sign: malformed checkpoint seq")?;
    // Audit seq is a Postgres bigint.
    if seq > i64::MAX as u64 {
        return Err("refusing to sign: malformed checkpoint seq".into());
    }
    if hash_s.len() != HASH_HEX_LEN || !hash_s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("refusing to sign: malformed checkpoint hash (need 64 lowercase hex characters)".into());
    }
    Ok(seq)
}

pub struct Guard {
    /// None = memory only (no state directory configured).
    path: Option<PathBuf>,
    last: Mutex<u64>,
}

impl Guard {
    /// Loads the last signed seq from `path` (0 if the file does not exist
    /// yet). A file that exists but cannot be read or parsed is an error:
    /// silently starting from 0 would undo the protection.
    pub fn open(path: Option<PathBuf>) -> Result<Self, String> {
        let last = match &path {
            None => 0,
            Some(p) => match std::fs::read_to_string(p) {
                Ok(s) => s.trim().parse::<u64>().map_err(|_| format!("checkpoint state {} is corrupt", p.display()))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(e) => return Err(format!("cannot read checkpoint state {}: {e}", p.display())),
            },
        };
        Ok(Guard { path, last: Mutex::new(last) })
    }

    pub fn last_signed(&self) -> u64 {
        *self.last.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Checks the message, records its seq durably, then signs. The lock is
    /// held throughout, so two concurrent requests cannot both pass.
    pub fn sign_checkpoint<F: FnOnce(&[u8]) -> [u8; 64]>(&self, msg: &[u8], sign: F) -> Result<[u8; 64], String> {
        let seq = parse(msg)?;
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if seq <= *last {
            return Err(format!(
                "refusing to sign: checkpoint seq {seq} is not above the last signed seq {}",
                *last
            ));
        }
        if let Some(p) = &self.path {
            persist(p, seq).map_err(|e| format!("refusing to sign: cannot record checkpoint seq: {e}"))?;
        }
        *last = seq;
        Ok(sign(msg))
    }
}

/// Write-to-temp, fsync, rename, fsync dir. Files are created 0600.
fn persist(path: &Path, seq: u64) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(format!("{seq}\n").as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        if let Ok(d) = File::open(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const H: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn msg(seq: &str) -> Vec<u8> {
        format!("{PREFIX}{seq}|{H}").into_bytes()
    }

    fn fake_sign(_: &[u8]) -> [u8; 64] {
        [9u8; 64]
    }

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tvkeyd-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("checkpoint-seq")
    }

    #[test]
    fn increasing_seq_signs() {
        let g = Guard::open(None).unwrap();
        assert!(g.sign_checkpoint(&msg("5"), fake_sign).is_ok());
        assert!(g.sign_checkpoint(&msg("6"), fake_sign).is_ok());
        assert!(g.sign_checkpoint(&msg("100"), fake_sign).is_ok());
        assert_eq!(g.last_signed(), 100);
    }

    #[test]
    fn equal_or_lower_seq_refused() {
        let g = Guard::open(None).unwrap();
        g.sign_checkpoint(&msg("10"), fake_sign).unwrap();
        let e = g.sign_checkpoint(&msg("10"), fake_sign).unwrap_err();
        assert!(e.contains("not above the last signed seq 10"), "{e}");
        assert!(g.sign_checkpoint(&msg("9"), fake_sign).is_err());
        assert_eq!(g.last_signed(), 10);
    }

    #[test]
    fn malformed_messages_refused() {
        let g = Guard::open(None).unwrap();
        let bad: Vec<Vec<u8>> = vec![
            b"transfer $1M".to_vec(),
            format!("tv-checkpoint-v2|5|{H}").into_bytes(),
            format!("{PREFIX}5|{H}|extra").into_bytes(),
            format!("{PREFIX}5").into_bytes(),
            msg(""),
            msg("0"),
            msg("05"),
            msg("+5"),
            msg("-5"),
            msg(" 5"),
            msg("5.0"),
            msg("0x10"),
            msg("9223372036854775808"),   // > i64::MAX
            msg("99999999999999999999"),  // > u64::MAX
            format!("{PREFIX}5|{}", &H[..62]).into_bytes(),
            format!("{PREFIX}5|{H}00").into_bytes(),
            format!("{PREFIX}5|{}", H.to_uppercase()).into_bytes(),
            format!("{PREFIX}5|{}zz", &H[..62]).into_bytes(),
            format!("{PREFIX}5|{H}\n").into_bytes(),
            vec![0xff, 0xfe],
        ];
        for m in bad {
            assert!(g.sign_checkpoint(&m, fake_sign).is_err(), "accepted {:?}", String::from_utf8_lossy(&m));
        }
        assert_eq!(g.last_signed(), 0, "a refused message must not move the counter");
        assert!(g.sign_checkpoint(&msg("9223372036854775807"), fake_sign).is_ok());
    }

    #[test]
    fn persisted_value_survives_restart() {
        let p = tmp_path("restart");
        {
            let g = Guard::open(Some(p.clone())).unwrap();
            g.sign_checkpoint(&msg("42"), fake_sign).unwrap();
        }
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let g = Guard::open(Some(p.clone())).unwrap();
        assert_eq!(g.last_signed(), 42);
        assert!(g.sign_checkpoint(&msg("42"), fake_sign).is_err());
        assert!(g.sign_checkpoint(&msg("41"), fake_sign).is_err());
        assert!(g.sign_checkpoint(&msg("43"), fake_sign).is_ok());
        assert_eq!(Guard::open(Some(p.clone())).unwrap().last_signed(), 43);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn corrupt_state_file_is_an_error_not_zero() {
        let p = tmp_path("corrupt");
        std::fs::write(&p, "not a number").unwrap();
        assert!(Guard::open(Some(p.clone())).is_err());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn unwritable_state_refuses_to_sign() {
        let p = tmp_path("unwritable").parent().unwrap().join("missing-dir").join("checkpoint-seq");
        let g = Guard::open(Some(p.clone())).unwrap();
        assert!(g.sign_checkpoint(&msg("1"), fake_sign).is_err());
        assert_eq!(g.last_signed(), 0);
        let _ = std::fs::remove_dir_all(p.parent().unwrap().parent().unwrap());
    }
}
