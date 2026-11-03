//! tvkeyd — TrustVault key service.
//!
//! Listens on a Unix socket. One JSON request per line, one JSON response
//! per line. It never returns a master key or anything derived from one
//! except signatures, public keys, and the results of wrap/unwrap/rewrap.
//!
//! Operations:
//!   wrap        {aad, data}                 wrap under the current generation
//!   unwrap      {aad, key_id, data, ticket} document data keys: ticket REQUIRED
//!                                           (see ticket.rs); TOTP secrets: no
//!                                           ticket, per-user rate limit
//!   rewrap      {aad, key_id, data}         re-wrap under the current generation;
//!                                           the plaintext never leaves keyd
//!   check       {aad, key_id, data}         does this value open? (no plaintext)
//!   sign        {data}                      audit checkpoint signature (checkpoint.rs)
//!   pubkey                                  audit checkpoint public key
//!   ledger_head                             signed head of the key-use ledger
//!   ledger_read {from, limit}               ledger entries (ledger.rs)
//!   status                                  generations, key ids, ticket key ids
//!
//! Defences, in order:
//!   1. The socket file is mode 0660, group = the socket group (only the
//!      API's service is a member).
//!   2. Every connection's peer uid is read from the kernel (SO_PEERCRED)
//!      and must equal KEYD_ALLOWED_UID; anything else is dropped.
//!   3. A document data key is only unwrapped with a database-issued,
//!      single-use, 60-second ticket bound to the user, document, version,
//!      wrapped key, action and an audit event.
//!   4. Per-user, global and per-class rate limits (ratelimit.rs).
//!   5. Every unwrap, refusal, rewrap and start is appended to keyd's own
//!      hash-chained ledger and fsynced BEFORE the key leaves the process.
//!   6. Requests are size- and time-limited; the process locks its memory
//!      (no swap) and is not dumpable (no core files, no ptrace).
//!
//! Configuration (environment, set by the systemd unit):
//!   KEYD_SOCKET         socket path               (/run/tvkeyd/keyd.sock)
//!   KEYD_KEY_DIR        where key files are read; defaults to
//!                       $CREDENTIALS_DIRECTORY (systemd LoadCredential), then /etc/tvkeyd
//!   KEYD_MASTER_KEY     generation-1 master key file (default <key dir>/master.key)
//!                       Later generations: <key dir>/master-N.key or extra_master-N.key
//!   KEYD_WRAP_GENERATION  generation new wraps use (default: highest present)
//!   KEYD_RETIRED_GENERATIONS  comma list; those keys can no longer unwrap
//!   KEYD_TICKET_KEY     ticket MAC key file (default <key dir>/ticket.key); an
//!                       optional second key ticket-prev.key / extra_ticket-prev.key
//!                       is accepted during ticket-key rotation
//!   KEYD_ALLOWED_UID    the only uid allowed to talk to us
//!   KEYD_SOCKET_GID     group to give the socket file
//!   KEYD_STATE_FILE     highest signed checkpoint seq; default $STATE_DIRECTORY/checkpoint-seq
//!   KEYD_LEDGER_FILE    key-use ledger; default $STATE_DIRECTORY/unwrap-ledger.jsonl
//!                       (memory only, with a warning, when neither is set)
//!   KEYD_LIMIT_*        rate limits, see ratelimit.rs

mod checkpoint;
mod crypto;
mod ledger;
mod ratelimit;
mod ticket;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

use crypto::Class;
use ledger::Entry;

const MAX_LINE: u64 = 64 * 1024;
const MAX_INPUT: usize = 4 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_LEDGER_PAGE: usize = 500;

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    aad: Option<String>,
    #[serde(default)]
    key_id: Option<String>,
    #[serde(default)]
    ticket: Option<String>,
    #[serde(default)]
    from: Option<u64>,
    #[serde(default)]
    limit: Option<u64>,
}

pub fn log(msg: &str) {
    eprintln!("tvkeyd: {msg}");
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn harden_process() {
    unsafe {
        // No core dumps and no ptrace from other processes of the same user.
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
        // Keep key material out of swap. Needs LimitMEMLOCK; warn if refused.
        if libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) != 0 {
            log("warning: mlockall failed; key material could be swapped");
        }
    }
}

/// 32 raw bytes, or base64 of 32 bytes.
fn read_key_file(path: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
    let raw = Zeroizing::new(std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?);
    if raw.len() == 32 {
        return Ok(Zeroizing::new(raw.to_vec()));
    }
    let text = Zeroizing::new(String::from_utf8_lossy(&raw).trim().to_string());
    let decoded = Zeroizing::new(B64.decode(text.as_bytes()).map_err(|_| format!("{} is neither 32 raw bytes nor base64", path.display()))?);
    if decoded.len() != 32 {
        return Err(format!("{} must hold 32 bytes", path.display()));
    }
    Ok(Zeroizing::new(decoded.to_vec()))
}

fn key_dir() -> PathBuf {
    std::env::var("KEYD_KEY_DIR")
        .or_else(|_| std::env::var("CREDENTIALS_DIRECTORY"))
        .unwrap_or_else(|_| "/etc/tvkeyd".into())
        .into()
}

fn parse_generations(s: &str) -> Result<BTreeSet<u32>, String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty())
        .map(|x| x.parse::<u32>().map_err(|_| format!("bad generation {x:?}")))
        .collect()
}

fn load_keys() -> Result<crypto::Keys, String> {
    let dir = key_dir();
    let first = std::env::var("KEYD_MASTER_KEY").map(PathBuf::from).unwrap_or_else(|_| dir.join("master.key"));
    let mut masters = BTreeMap::new();
    masters.insert(1u32, read_key_file(&first)?);
    for n in 2..=64u32 {
        for name in [format!("master-{n}.key"), format!("extra_master-{n}.key")] {
            let p = dir.join(&name);
            if p.exists() {
                masters.insert(n, read_key_file(&p)?);
            }
        }
    }
    let current = match std::env::var("KEYD_WRAP_GENERATION") {
        Ok(s) => Some(s.trim().parse::<u32>().map_err(|_| "KEYD_WRAP_GENERATION must be a number")?),
        Err(_) => None,
    };
    let retired = parse_generations(&env_or("KEYD_RETIRED_GENERATIONS", ""))?;
    crypto::Keys::from_generations(&masters, current, &retired)
}

fn load_ticket_keys() -> Result<ticket::TicketKeys, String> {
    let dir = key_dir();
    let main = std::env::var("KEYD_TICKET_KEY").map(PathBuf::from).unwrap_or_else(|_| dir.join("ticket.key"));
    let mut keys = vec![read_key_file(&main)?];
    for name in ["ticket-prev.key", "extra_ticket-prev.key"] {
        let p = dir.join(name);
        if p.exists() {
            keys.push(read_key_file(&p)?);
        }
    }
    ticket::TicketKeys::new(keys)
}

/// The uid of the process on the other end of the socket, from the kernel.
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc == 0 { Some(cred.uid) } else { None }
}

fn b64_input(v: &Option<String>) -> Result<Zeroizing<Vec<u8>>, String> {
    let s = v.as_deref().ok_or("missing data")?;
    let bytes = Zeroizing::new(B64.decode(s).map_err(|_| "data is not base64")?);
    if bytes.len() > MAX_INPUT {
        return Err("data too large".into());
    }
    Ok(bytes)
}

pub struct State {
    keys: crypto::Keys,
    checkpoints: checkpoint::Guard,
    tickets: ticket::TicketKeys,
    replay: ticket::ReplayCache,
    limiter: ratelimit::RateLimiter,
    ledger: ledger::Ledger,
    /// Refusals not written to the ledger because of the refusal log limit.
    suppressed: AtomicU64,
    /// Clock (unix ms), replaceable in tests.
    clock: fn() -> u64,
}

fn state_dir_file(name: &str) -> Option<PathBuf> {
    std::env::var("STATE_DIRECTORY").ok().map(|d| {
        // systemd may pass several colon-separated directories; use the first.
        let first = d.split(':').next().unwrap_or(&d).to_string();
        Path::new(&first).join(name)
    })
}

fn state_path() -> Option<PathBuf> {
    std::env::var("KEYD_STATE_FILE").ok().map(PathBuf::from).or_else(|| state_dir_file("checkpoint-seq"))
}

fn ledger_path() -> Option<PathBuf> {
    std::env::var("KEYD_LEDGER_FILE").ok().map(PathBuf::from).or_else(|| state_dir_file("unwrap-ledger.jsonl"))
}

impl State {
    fn build(
        keys: crypto::Keys,
        checkpoints: checkpoint::Guard,
        tickets: ticket::TicketKeys,
        limits: ratelimit::Limits,
        ledger_file: Option<PathBuf>,
        clock: fn() -> u64,
    ) -> Result<State, String> {
        let now_s = clock() / 1000;
        let replay = ticket::ReplayCache::new();
        let keep = 2 * ticket::MAX_TTL + ticket::MAX_SKEW;
        // Rebuild what must survive a restart: ticket ids still within their
        // lifetime (a restart must not make a used ticket usable again).
        let ledger = ledger::Ledger::open(ledger_file, |e| {
            let ts = e.ts / 1000;
            if let Some(tid) = &e.tid {
                if ts + keep > now_s {
                    replay.first_use(tid, ts + keep, now_s);
                }
            }
        })?;
        let st = State {
            keys,
            checkpoints,
            tickets,
            replay,
            limiter: ratelimit::RateLimiter::new(limits),
            ledger,
            suppressed: AtomicU64::new(0),
            clock,
        };
        let k = &st.keys;
        let mut boot = [0u8; 8];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut boot);
        let detail = format!(
            "generations={:?} current={} retired={:?} ticket_kids={:?} boot={}",
            k.generations(), k.current_generation(), k.retired(), st.tickets.kids(), ticket::hex(&boot)
        );
        st.ledger.append(Entry { event: "start".into(), result: "ok".into(), detail: Some(detail), ..Default::default() }, clock())?;
        Ok(st)
    }

    /// Writes a refusal to the ledger unless the refusal log limit is hit;
    /// then it is only counted (the count goes into the next logged one).
    fn refuse(&self, mut e: Entry, reason: &str) -> String {
        let now = (self.clock)();
        if self.limiter.log_refusal(now / 1000) {
            let n = self.suppressed.swap(0, Ordering::SeqCst);
            e.event = "refuse".into();
            e.result = reason.into();
            if n > 0 {
                e.detail = Some(format!("suppressed={n}"));
            }
            if let Err(err) = self.ledger.append(e, now) {
                log(&format!("cannot ledger a refusal: {err}"));
            }
        } else {
            self.suppressed.fetch_add(1, Ordering::SeqCst);
        }
        reason.to_string()
    }
}

fn ticket_entry(t: &ticket::Ticket, key_id: &str, aad: &str) -> Entry {
    Entry {
        action: Some(t.action.clone()),
        tid: Some(t.tid.clone()),
        user: t.user.clone(),
        doc: Some(t.doc.clone()),
        ver: Some(t.ver.clone()),
        audit_id: Some(t.audit_id.clone()),
        audit_seq: Some(t.audit_seq),
        key_id: Some(key_id.to_string()),
        aad_sha256: Some(ticket::sha256_hex(aad.as_bytes())),
        ..Default::default()
    }
}

/// Document data key: ticket required, checked in full, ledgered before release.
fn unwrap_blob(state: &State, ticket_s: Option<&str>, key_id: &str, sealed: &[u8], aad: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let now_ms = (state.clock)();
    let now = now_ms / 1000;
    let bare = Entry { key_id: Some(key_id.into()), aad_sha256: Some(ticket::sha256_hex(aad.as_bytes())), ..Default::default() };
    let Some(ticket_s) = ticket_s else {
        return Err(state.refuse(bare, "ticket required"));
    };
    let t = match state.tickets.verify_mac(ticket_s) {
        Ok(t) => t,
        Err(e) => return Err(state.refuse(bare, &e)),
    };
    let entry = ticket_entry(&t, key_id, aad);
    if let Err(e) = ticket::check_binding(&t, now, aad, sealed) {
        return Err(state.refuse(entry, &e));
    }
    // Single use: consumed by the first attempt, whatever happens next.
    if !state.replay.first_use(&t.tid, t.exp + ticket::MAX_SKEW, now) {
        return Err(state.refuse(entry, "ticket already used"));
    }
    let allowed = match &t.user {
        Some(u) => state.limiter.user_unwrap(u, now),
        None => state.limiter.system_unwrap(&t.action, now),
    };
    if !allowed {
        return Err(state.refuse(entry, "rate limited"));
    }
    let plain = match state.keys.unwrap(key_id, sealed, aad) {
        Ok(p) => p,
        Err(e) => {
            let mut failed = entry;
            failed.event = "unwrap".into();
            failed.result = e.clone();
            state.ledger.append(failed, now_ms).map_err(|le| format!("cannot record unwrap: {le}"))?;
            return Err(e);
        }
    };
    let mut ok = entry;
    ok.event = "unwrap".into();
    ok.result = "ok".into();
    // Durable record first; on failure the key is dropped (zeroized) unsent.
    state.ledger.append(ok, now_ms).map_err(|e| format!("cannot record unwrap: {e}"))?;
    Ok(plain)
}

/// TOTP secret: no ticket (docs/KEYS.md, "TOTP exception"), rate limited per user, ledgered.
fn unwrap_totp(state: &State, ticket_s: Option<&str>, key_id: &str, sealed: &[u8], aad: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let now_ms = (state.clock)();
    let user = aad[crypto::TOTP_AAD_PREFIX.len()..].to_string();
    let entry = Entry { action: Some("totp".into()), user: Some(user.clone()), key_id: Some(key_id.into()), ..Default::default() };
    if ticket_s.is_some() {
        return Err(state.refuse(entry, "totp unwraps take no ticket"));
    }
    if !state.limiter.totp_unwrap(&user, now_ms / 1000) {
        return Err(state.refuse(entry, "rate limited"));
    }
    let res = state.keys.unwrap(key_id, sealed, aad);
    let mut e = entry;
    e.event = "totp_unwrap".into();
    e.result = match &res { Ok(_) => "ok".into(), Err(err) => err.clone() };
    state.ledger.append(e, now_ms).map_err(|le| format!("cannot record unwrap: {le}"))?;
    res
}

fn handle(state: &State, line: &str) -> Value {
    let keys = &state.keys;
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(_) => return json!({ "error": "bad request" }),
    };
    let result: Result<Value, String> = (|| match req.op.as_str() {
        "wrap" => {
            let data = b64_input(&req.data)?;
            let aad = req.aad.as_deref().ok_or("missing aad")?;
            let (sealed, key_id) = keys.wrap(&data, aad)?;
            Ok(json!({ "data": B64.encode(sealed), "key_id": key_id }))
        }
        "unwrap" => {
            let key_id = req.key_id.as_deref().ok_or("missing key id")?;
            let sealed = b64_input(&req.data)?;
            let aad = req.aad.as_deref().ok_or("missing aad")?;
            let plain = match crypto::class_of(aad)? {
                Class::Blob => unwrap_blob(state, req.ticket.as_deref(), key_id, &sealed, aad)?,
                Class::Totp => unwrap_totp(state, req.ticket.as_deref(), key_id, &sealed, aad)?,
            };
            Ok(json!({ "data": B64.encode(&*plain) }))
        }
        "rewrap" => {
            let key_id = req.key_id.as_deref().ok_or("missing key id")?;
            let sealed = b64_input(&req.data)?;
            let aad = req.aad.as_deref().ok_or("missing aad")?;
            let now_ms = (state.clock)();
            if !state.limiter.rewrap(now_ms / 1000) {
                return Err("rate limited".into());
            }
            let (data, new_id, changed) = match keys.rewrap(key_id, &sealed, aad)? {
                Some((s, id)) => (s, id, true),
                None => (sealed.to_vec(), key_id.to_string(), false),
            };
            if changed {
                let e = Entry {
                    event: "rewrap".into(), result: "ok".into(), key_id: Some(key_id.into()),
                    aad_sha256: Some(ticket::sha256_hex(aad.as_bytes())), detail: Some(new_id.clone()), ..Default::default()
                };
                state.ledger.append(e, now_ms).map_err(|e| format!("cannot record rewrap: {e}"))?;
            }
            Ok(json!({ "data": B64.encode(data), "key_id": new_id, "changed": changed }))
        }
        "check" => {
            let key_id = req.key_id.as_deref().ok_or("missing key id")?;
            let sealed = b64_input(&req.data)?;
            let aad = req.aad.as_deref().ok_or("missing aad")?;
            let class = crypto::class_of(aad)?;
            let ok = keys.unwrap(key_id, &sealed, aad).is_ok();
            Ok(json!({ "ok": ok, "current": ok && key_id == keys.current_key_id(class) }))
        }
        "sign" => {
            let msg = b64_input(&req.data)?;
            // Only well-formed audit checkpoints are ever signed, and only
            // with a seq above every one signed before (see checkpoint.rs).
            let sig = state.checkpoints.sign_checkpoint(&msg, |m| keys.sign(m))?;
            Ok(json!({ "signature": B64.encode(sig), "key_id": crypto::SIGN_KEY_ID }))
        }
        "pubkey" => Ok(json!({ "public_key": B64.encode(keys.public_key()), "key_id": crypto::SIGN_KEY_ID })),
        "ledger_head" => {
            // keyd chooses what it signs here: its own head, nothing from the caller.
            let (seq, hash) = state.ledger.head();
            let sig = keys.ledger_sign(ledger::head_message(seq, &hash).as_bytes());
            Ok(json!({
                "seq": seq, "head_hash": hash, "signature": B64.encode(sig),
                "public_key": B64.encode(keys.ledger_public_key()), "key_id": crypto::LEDGER_SIGN_KEY_ID,
            }))
        }
        "ledger_read" => {
            let from = req.from.unwrap_or(1);
            let limit = req.limit.unwrap_or(MAX_LEDGER_PAGE as u64).min(MAX_LEDGER_PAGE as u64) as usize;
            Ok(json!({ "entries": state.ledger.read(from, limit)? }))
        }
        "status" => Ok(json!({
            "generation": keys.current_generation(),
            "generations": keys.generations(),
            "retired": keys.retired(),
            "wrap_key_ids": { "blob": keys.current_key_id(Class::Blob), "totp": keys.current_key_id(Class::Totp) },
            "ticket_kids": state.tickets.kids(),
            "ledger_seq": state.ledger.head().0,
        })),
        _ => Err("unknown op".into()),
    })();
    match result {
        Ok(v) => v,
        Err(e) => json!({ "error": e }),
    }
}

fn serve(state: Arc<State>, stream: UnixStream, allowed_uid: u32) {
    match peer_uid(&stream) {
        Some(uid) if uid == allowed_uid => {}
        other => {
            log(&format!("refused connection from uid {:?}", other));
            return;
        }
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream.take(MAX_LINE));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.is_empty() {
        return;
    }
    let response = handle(&state, line.trim_end());
    let _ = writer.write_all(format!("{response}\n").as_bytes());
}

fn exit_with(msg: String) -> ! {
    log(&msg);
    std::process::exit(2);
}

fn main() {
    harden_process();
    let socket_path = env_or("KEYD_SOCKET", "/run/tvkeyd/keyd.sock");
    let allowed_uid: u32 = std::env::var("KEYD_ALLOWED_UID").ok().and_then(|v| v.parse().ok())
        .unwrap_or_else(|| exit_with("KEYD_ALLOWED_UID is required".into()));
    let keys = load_keys().unwrap_or_else(|e| exit_with(format!("cannot load master keys: {e}")));
    let tickets = load_ticket_keys().unwrap_or_else(|e| exit_with(format!("cannot load ticket key: {e}")));
    let limits = ratelimit::Limits::from_env().unwrap_or_else(|e| exit_with(e));
    let state_file = state_path();
    let ledger_file = ledger_path();
    if state_file.is_none() || ledger_file.is_none() {
        log("warning: no STATE_DIRECTORY; checkpoint seq and the key-use ledger are kept in memory only and reset on restart");
    }
    let checkpoints = checkpoint::Guard::open(state_file).unwrap_or_else(|e| exit_with(format!("cannot load checkpoint state: {e}")));
    let state = State::build(keys, checkpoints, tickets, limits, ledger_file, now_ms)
        .unwrap_or_else(|e| exit_with(format!("cannot open the key-use ledger: {e}")));
    log(&format!(
        "last signed checkpoint seq {}; ledger seq {}; wrap generation {}",
        state.checkpoints.last_signed(), state.ledger.head().0, state.keys.current_generation()
    ));
    let state = Arc::new(state);

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap_or_else(|e| exit_with(format!("cannot bind {socket_path}: {e}")));
    if let Err(e) = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o660)) {
        exit_with(format!("cannot chmod socket: {e}"));
    }
    if let Some(gid) = std::env::var("KEYD_SOCKET_GID").ok().and_then(|v| v.parse::<u32>().ok()) {
        if let Err(e) = std::os::unix::fs::chown(&socket_path, None, Some(gid)) {
            exit_with(format!("cannot chgrp socket: {e}"));
        }
    }
    log(&format!("listening on {socket_path}, allowed uid {allowed_uid}"));

    let active = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        if active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            continue; // drop: too many concurrent requests
        }
        let state = Arc::clone(&state);
        let active = Arc::clone(&active);
        active.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            serve(state, stream, allowed_uid);
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::tests::{blob_aad, legacy_wrap, DOC, USER, VER};
    use crate::ticket::tests::{keys as ticket_keys, ticket, NOW};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    fn clock() -> u64 {
        (NOW + 1) * 1000
    }

    fn state_with(limits: ratelimit::Limits, ledger_file: Option<PathBuf>) -> State {
        State::build(
            crypto::Keys::from_master(&[3u8; 32]).unwrap(),
            checkpoint::Guard::open(None).unwrap(),
            ticket_keys(),
            limits,
            ledger_file,
            clock,
        )
        .unwrap()
    }

    fn state() -> State {
        state_with(ratelimit::Limits::default(), None)
    }

    fn sign_req(msg: &str) -> String {
        json!({"op":"sign","data":B64.encode(msg)}).to_string()
    }

    /// Wraps a data key for the test document version; returns (wrapped, key id).
    fn wrapped(st: &State) -> (Vec<u8>, String) {
        let w = handle(st, &json!({"op":"wrap","aad":blob_aad(),"data":B64.encode(b"data-key")}).to_string());
        (B64.decode(w["data"].as_str().unwrap()).unwrap(), w["key_id"].as_str().unwrap().to_string())
    }

    fn unwrap_req(wk: &[u8], key_id: &str, aad: &str, ticket: Option<&str>) -> String {
        let mut r = json!({"op":"unwrap","aad":aad,"key_id":key_id,"data":B64.encode(wk)});
        if let Some(t) = ticket {
            r["ticket"] = json!(t);
        }
        r.to_string()
    }

    fn ledger(st: &State) -> Vec<Entry> {
        st.ledger.read(1, 1000).unwrap()
    }

    #[test]
    fn ticketed_unwrap_works_once_and_is_ledgered() {
        let st = state();
        let (wk, id) = wrapped(&st);
        let t = ticket(&wk);
        let s = ticket_keys().mint(&t);
        let r = handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&s)));
        assert_eq!(B64.decode(r["data"].as_str().unwrap()).unwrap(), b"data-key");
        let l = ledger(&st);
        let last = l.last().unwrap();
        assert_eq!((last.event.as_str(), last.result.as_str()), ("unwrap", "ok"));
        assert_eq!(last.tid.as_deref(), Some(t.tid.as_str()));
        assert_eq!(last.user.as_deref(), Some(USER));
        assert_eq!(last.doc.as_deref(), Some(DOC));
        assert_eq!(last.ver.as_deref(), Some(VER));
        assert_eq!(last.audit_id.as_deref(), Some(t.audit_id.as_str()));
        assert_eq!(last.audit_seq, Some(42));
        let again = handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&s)));
        assert_eq!(again["error"], "ticket already used");
        assert_eq!(ledger(&st).last().unwrap().result, "ticket already used");
    }

    #[test]
    fn compromised_api_cannot_unwrap_without_a_valid_ticket() {
        let st = state();
        let (wk, id) = wrapped(&st);
        // 1. No ticket at all: the old protocol no longer works.
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), None))["error"], "ticket required");
        // 2. A forged ticket (the attacker does not have the ticket key).
        let attacker = ticket::TicketKeys::new(vec![Zeroizing::new(vec![9u8; 32])]).unwrap();
        let mut t = ticket(&wk);
        t.kid = ticket::kid_of(&[9u8; 32]);
        let forged = attacker.mint(&t).replacen(&ticket::kid_of(&[9u8; 32]), &ticket::kid_of(&ticket::tests::KEY), 1);
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&forged)))["error"], "bad ticket mac");
        // 3. A real ticket for document A used on document B.
        let aad_b = format!("tv-blob-v1|66666666-6666-4666-8666-666666666666|{VER}|1");
        let wb = handle(&st, &json!({"op":"wrap","aad":aad_b,"data":B64.encode(b"key-b")}).to_string());
        let wk_b = B64.decode(wb["data"].as_str().unwrap()).unwrap();
        let ticket_a = ticket_keys().mint(&ticket(&wk));
        assert_eq!(handle(&st, &unwrap_req(&wk_b, &id, &aad_b, Some(&ticket_a)))["error"], "ticket is for another document version");
        // 4. ... or on another wrapped key presented with A's AAD.
        let mut t2 = ticket(&wk);
        t2.tid = "77777777-7777-4777-8777-777777777777".into();
        assert_eq!(handle(&st, &unwrap_req(&wk_b, &id, &blob_aad(), Some(&ticket_keys().mint(&t2))))["error"], "ticket is for another wrapped key");
        // 5. The ticket-less TOTP path cannot open a blob value.
        let totp_aad = format!("tv-totp-v1|{USER}");
        assert!(handle(&st, &unwrap_req(&wk, "keyd-g1-totp", &totp_aad, None))["error"].is_string());
        assert!(handle(&st, &unwrap_req(&wk, &id, &totp_aad, None))["error"].is_string());
        let refusals: Vec<String> = ledger(&st).iter().filter(|e| e.event == "refuse").map(|e| e.result.clone()).collect();
        assert_eq!(refusals, vec!["ticket required", "bad ticket mac", "ticket is for another document version", "ticket is for another wrapped key"]);
    }

    #[test]
    fn expired_ticket_refused() {
        let st = state();
        let (wk, id) = wrapped(&st);
        let mut t = ticket(&wk);
        t.iat = NOW - 100;
        t.exp = NOW - 50;
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&t))))["error"], "ticket expired");
    }

    #[test]
    fn legacy_wrapped_keys_still_open_with_a_ticket() {
        let st = state();
        let wk = legacy_wrap(&[3u8; 32], b"old-key", &blob_aad());
        let s = ticket_keys().mint(&ticket(&wk));
        let r = handle(&st, &unwrap_req(&wk, crypto::LEGACY_WRAP_KEY_ID, &blob_aad(), Some(&s)));
        assert_eq!(B64.decode(r["data"].as_str().unwrap()).unwrap(), b"old-key");
    }

    #[test]
    fn per_user_rate_limit_applies() {
        let st = state_with(ratelimit::Limits { user_per_min: 2, ..Default::default() }, None);
        let (wk, id) = wrapped(&st);
        for (n, want_ok) in [(1, true), (2, true), (3, false)] {
            let mut t = ticket(&wk);
            t.tid = format!("44444444-4444-4444-8444-44444444444{n}");
            let r = handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&t))));
            assert_eq!(r["data"].is_string(), want_ok, "{r}");
        }
        assert_eq!(ledger(&st).last().unwrap().result, "rate limited");
    }

    #[test]
    fn system_unwraps_have_their_own_limit_and_maintenance_is_off_by_default() {
        let st = state_with(ratelimit::Limits { system_per_hour: 1, ..Default::default() }, None);
        let (wk, id) = wrapped(&st);
        let mut t = ticket(&wk);
        t.action = "rescan".into();
        t.user = None;
        assert!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&t))))["data"].is_string());
        t.tid = "88888888-8888-4888-8888-888888888888".into();
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&t))))["error"], "rate limited");
        t.action = "reencrypt".into();
        t.tid = "99999999-9999-4999-8999-999999999999".into();
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&t))))["error"], "rate limited");
    }

    #[test]
    fn totp_unwrap_needs_no_ticket_but_is_limited_and_ledgered() {
        let st = state_with(ratelimit::Limits { totp_per_user_10min: 1, ..Default::default() }, None);
        let aad = format!("tv-totp-v1|{USER}");
        let w = handle(&st, &json!({"op":"wrap","aad":aad,"data":B64.encode(b"totp-secret")}).to_string());
        assert_eq!(w["key_id"], "keyd-g1-totp");
        let req = json!({"op":"unwrap","aad":aad,"key_id":w["key_id"],"data":w["data"]}).to_string();
        assert_eq!(B64.decode(handle(&st, &req)["data"].as_str().unwrap()).unwrap(), b"totp-secret");
        assert_eq!(handle(&st, &req)["error"], "rate limited");
        assert!(ledger(&st).iter().any(|e| e.event == "totp_unwrap" && e.user.as_deref() == Some(USER) && e.result == "ok"));
    }

    #[test]
    fn rewrap_and_check_never_return_plaintext() {
        let st = state();
        let wk = legacy_wrap(&[3u8; 32], b"dek", &blob_aad());
        let r = handle(&st, &json!({"op":"rewrap","aad":blob_aad(),"key_id":"keyd-wrap-v1","data":B64.encode(&wk)}).to_string());
        assert_eq!(r["key_id"], "keyd-g1-blob");
        assert_eq!(r["changed"], true);
        assert_ne!(B64.decode(r["data"].as_str().unwrap()).unwrap(), b"dek");
        let again = handle(&st, &json!({"op":"rewrap","aad":blob_aad(),"key_id":"keyd-g1-blob","data":r["data"]}).to_string());
        assert_eq!(again["changed"], false);
        assert_eq!(again["data"], r["data"]);
        let c = handle(&st, &json!({"op":"check","aad":blob_aad(),"key_id":"keyd-g1-blob","data":r["data"]}).to_string());
        assert_eq!((c["ok"].as_bool(), c["current"].as_bool()), (Some(true), Some(true)));
        let bad = handle(&st, &json!({"op":"check","aad":blob_aad(),"key_id":"keyd-g1-blob","data":B64.encode(&wk)}).to_string());
        assert_eq!(bad["ok"], false);
        assert!(ledger(&st).iter().any(|e| e.event == "rewrap" && e.detail.as_deref() == Some("keyd-g1-blob")));
    }

    #[test]
    fn ledger_head_is_signed_with_the_ledger_key() {
        let st = state();
        let (wk, id) = wrapped(&st);
        handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&ticket_keys().mint(&ticket(&wk)))));
        let h = handle(&st, r#"{"op":"ledger_head"}"#);
        let seq = h["seq"].as_u64().unwrap();
        assert_eq!(seq, 2, "start + unwrap");
        let msg = ledger::head_message(seq, h["head_hash"].as_str().unwrap());
        let pk: [u8; 32] = B64.decode(h["public_key"].as_str().unwrap()).unwrap().try_into().unwrap();
        let sig: [u8; 64] = B64.decode(h["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert!(VerifyingKey::from_bytes(&pk).unwrap().verify(msg.as_bytes(), &Signature::from_bytes(&sig)).is_ok());
        assert_ne!(h["public_key"], handle(&st, r#"{"op":"pubkey"}"#)["public_key"], "ledger key is not the audit key");
        let page = handle(&st, r#"{"op":"ledger_read","from":2,"limit":10}"#);
        assert_eq!(page["entries"][0]["event"], "unwrap");
        assert_eq!(page["entries"][0]["hash"], h["head_hash"]);
    }

    #[test]
    fn restart_keeps_used_tickets_used() {
        let dir = std::env::temp_dir().join(format!("tvkeyd-main-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("unwrap-ledger.jsonl");
        let (wk, id, s) = {
            let st = state_with(ratelimit::Limits::default(), Some(p.clone()));
            let (wk, id) = wrapped(&st);
            let s = ticket_keys().mint(&ticket(&wk));
            assert!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&s)))["data"].is_string());
            (wk, id, s)
        };
        let st = state_with(ratelimit::Limits::default(), Some(p.clone()));
        assert_eq!(handle(&st, &unwrap_req(&wk, &id, &blob_aad(), Some(&s)))["error"], "ticket already used");
        let events: Vec<String> = ledger(&st).iter().map(|e| e.event.clone()).collect();
        assert_eq!(events, vec!["start", "unwrap", "start", "refuse"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusal_flood_is_counted_not_ledgered() {
        let st = state_with(ratelimit::Limits { refusals_logged_per_min: 2, ..Default::default() }, None);
        let (wk, id) = wrapped(&st);
        for _ in 0..10 {
            handle(&st, &unwrap_req(&wk, &id, &blob_aad(), None));
        }
        assert_eq!(ledger(&st).iter().filter(|e| e.event == "refuse").count(), 2);
        assert_eq!(st.suppressed.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn refuses_to_sign_non_checkpoints() {
        let r = handle(&state(), &json!({"op":"sign","data":B64.encode(b"transfer $1M")}).to_string());
        assert!(r["error"].is_string());
    }

    #[test]
    fn signs_increasing_checkpoints_and_refuses_replays_over_protocol() {
        let k = state();
        let h = "ab".repeat(32);
        let m5 = format!("tv-checkpoint-v1|5|{h}");
        let r = handle(&k, &sign_req(&m5));
        assert_eq!(r["key_id"], crypto::SIGN_KEY_ID);
        assert_eq!(B64.decode(r["signature"].as_str().unwrap()).unwrap(), k.keys.sign(m5.as_bytes()).to_vec());
        let again = handle(&k, &sign_req(&m5));
        assert!(again["error"].as_str().unwrap().contains("not above the last signed seq 5"));
        assert!(handle(&k, &sign_req(&format!("tv-checkpoint-v1|4|{h}")))["error"].is_string());
        assert!(handle(&k, &sign_req(&format!("tv-checkpoint-v1|6|{h}")))["signature"].is_string());
        assert!(handle(&k, &sign_req("tv-checkpoint-v1|7|abcd"))["error"].is_string());
    }

    #[test]
    fn rejects_oversized_input() {
        let r = handle(&state(), &json!({"op":"wrap","aad":blob_aad(),"data":B64.encode(vec![0u8; MAX_INPUT + 1])}).to_string());
        assert_eq!(r["error"], "data too large");
    }

    #[test]
    fn rejects_unknown_key_id_and_op() {
        let k = state();
        assert!(handle(&k, &json!({"op":"unwrap","aad":blob_aad(),"key_id":"other","data":"AAAA"}).to_string())["error"].is_string());
        assert!(handle(&k, r#"{"op":"dump_master"}"#)["error"].is_string());
        assert!(handle(&k, "not json")["error"].is_string());
        assert_eq!(handle(&k, r#"{"op":"wrap","aad":"anything","data":"AAAA"}"#)["error"], "unsupported aad");
    }

    #[test]
    fn status_reports_generations() {
        let s = handle(&state(), r#"{"op":"status"}"#);
        assert_eq!(s["generation"], 1);
        assert_eq!(s["wrap_key_ids"]["blob"], "keyd-g1-blob");
        assert_eq!(s["ticket_kids"].as_array().unwrap().len(), 1);
    }
}
