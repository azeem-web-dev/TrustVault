//! tvkeyd — TrustVault key service.
//!
//! Listens on a Unix socket. One JSON request per line, one JSON response
//! per line. Operations: wrap, unwrap, sign, pubkey. It never returns the
//! master key or anything derived from it except signatures, the public
//! key, and the results of wrap/unwrap.
//!
//! Defences, in order:
//!   1. The socket file is mode 0660, group = the socket group (only the
//!      API's service is a member).
//!   2. Every connection's peer uid is read from the kernel (SO_PEERCRED)
//!      and must equal KEYD_ALLOWED_UID; anything else is dropped.
//!   3. Requests are size- and time-limited; inputs to wrap/sign are small.
//!   4. The process locks its memory (no swap) and is not dumpable (no core
//!      files, no ptrace by same-uid processes).
//!
//! Configuration (environment, set by the systemd unit):
//!   KEYD_SOCKET         socket path               (/run/tvkeyd/keyd.sock)
//!   KEYD_MASTER_KEY     file with 32 raw bytes or base64; defaults to
//!                       $CREDENTIALS_DIRECTORY/master.key (systemd LoadCredential)
//!   KEYD_ALLOWED_UID    the only uid allowed to talk to us
//!   KEYD_SOCKET_GID     group to give the socket file
//!   KEYD_STATE_FILE     where the highest signed checkpoint seq is kept;
//!                       defaults to $STATE_DIRECTORY/checkpoint-seq
//!                       (systemd StateDirectory=). With neither set the
//!                       value is kept in memory only (warning at startup).

mod checkpoint;
mod crypto;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

const MAX_LINE: u64 = 64 * 1024;
const MAX_INPUT: usize = 4 * 1024;
const MAX_CONNECTIONS: usize = 64;

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    aad: Option<String>,
    #[serde(default)]
    key_id: Option<String>,
}

fn log(msg: &str) {
    eprintln!("tvkeyd: {msg}");
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
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

fn load_master() -> Result<Zeroizing<Vec<u8>>, String> {
    let path = std::env::var("KEYD_MASTER_KEY").unwrap_or_else(|_| {
        format!("{}/master.key", env_or("CREDENTIALS_DIRECTORY", "/etc/tvkeyd"))
    });
    let raw = Zeroizing::new(std::fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?);
    if raw.len() == 32 {
        return Ok(Zeroizing::new(raw.to_vec()));
    }
    let text = String::from_utf8_lossy(&raw).trim().to_string();
    let decoded = Zeroizing::new(B64.decode(text.as_bytes()).map_err(|_| "master key is neither 32 raw bytes nor base64")?);
    Ok(Zeroizing::new(decoded.to_vec()))
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

struct State {
    keys: crypto::Keys,
    checkpoints: checkpoint::Guard,
}

fn state_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("KEYD_STATE_FILE") {
        return Some(p.into());
    }
    std::env::var("STATE_DIRECTORY").ok().map(|d| {
        // systemd may pass several colon-separated directories; use the first.
        let first = d.split(':').next().unwrap_or(&d).to_string();
        std::path::Path::new(&first).join("checkpoint-seq")
    })
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
            let sealed = keys.wrap(&data, aad.as_bytes())?;
            Ok(json!({ "data": B64.encode(sealed), "key_id": crypto::WRAP_KEY_ID }))
        }
        "unwrap" => {
            if req.key_id.as_deref() != Some(crypto::WRAP_KEY_ID) {
                return Err("unknown key id".into());
            }
            let sealed = b64_input(&req.data)?;
            let aad = req.aad.as_deref().ok_or("missing aad")?;
            let plain = keys.unwrap(&sealed, aad.as_bytes())?;
            Ok(json!({ "data": B64.encode(&*plain) }))
        }
        "sign" => {
            let msg = b64_input(&req.data)?;
            // Only well-formed audit checkpoints are ever signed, and only
            // with a seq above every one signed before (see checkpoint.rs):
            // a compromised API can neither get arbitrary messages signed
            // nor a far-future checkpoint that stops later signing.
            let sig = state.checkpoints.sign_checkpoint(&msg, |m| keys.sign(m))?;
            Ok(json!({ "signature": B64.encode(sig), "key_id": crypto::SIGN_KEY_ID }))
        }
        "pubkey" => Ok(json!({ "public_key": B64.encode(keys.public_key()), "key_id": crypto::SIGN_KEY_ID })),
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

fn main() {
    harden_process();
    let socket_path = env_or("KEYD_SOCKET", "/run/tvkeyd/keyd.sock");
    let allowed_uid: u32 = match std::env::var("KEYD_ALLOWED_UID").ok().and_then(|v| v.parse().ok()) {
        Some(uid) => uid,
        None => {
            log("KEYD_ALLOWED_UID is required");
            std::process::exit(2);
        }
    };

    let keys = match load_master().and_then(|m| crypto::Keys::from_master(&m)) {
        Ok(k) => k,
        Err(e) => {
            log(&format!("cannot load master key: {e}"));
            std::process::exit(2);
        }
    };
    let state_file = state_path();
    if state_file.is_none() {
        log("warning: no KEYD_STATE_FILE or STATE_DIRECTORY; last checkpoint seq is kept in memory only and resets on restart");
    }
    let checkpoints = match checkpoint::Guard::open(state_file) {
        Ok(g) => g,
        Err(e) => {
            log(&format!("cannot load checkpoint state: {e}"));
            std::process::exit(2);
        }
    };
    log(&format!("last signed checkpoint seq {}", checkpoints.last_signed()));
    let state = Arc::new(State { keys, checkpoints });

    let _ = std::fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("cannot bind {socket_path}: {e}"));
            std::process::exit(2);
        }
    };
    if let Err(e) = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o660)) {
        log(&format!("cannot chmod socket: {e}"));
        std::process::exit(2);
    }
    if let Some(gid) = std::env::var("KEYD_SOCKET_GID").ok().and_then(|v| v.parse::<u32>().ok()) {
        if let Err(e) = std::os::unix::fs::chown(&socket_path, None, Some(gid)) {
            log(&format!("cannot chgrp socket: {e}"));
            std::process::exit(2);
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

    fn keys() -> State {
        State {
            keys: crypto::Keys::from_master(&[3u8; 32]).unwrap(),
            checkpoints: checkpoint::Guard::open(None).unwrap(),
        }
    }

    fn sign_req(msg: &str) -> String {
        json!({"op":"sign","data":B64.encode(msg)}).to_string()
    }

    #[test]
    fn wrap_then_unwrap_over_protocol() {
        let k = keys();
        let w = handle(&k, &json!({"op":"wrap","aad":"a","data":B64.encode(b"key")}).to_string());
        let sealed = w["data"].as_str().unwrap();
        let u = handle(&k, &json!({"op":"unwrap","aad":"a","key_id":crypto::WRAP_KEY_ID,"data":sealed}).to_string());
        assert_eq!(B64.decode(u["data"].as_str().unwrap()).unwrap(), b"key");
    }

    #[test]
    fn refuses_to_sign_non_checkpoints() {
        let r = handle(&keys(), &json!({"op":"sign","data":B64.encode(b"transfer $1M")}).to_string());
        assert!(r["error"].is_string());
    }

    #[test]
    fn signs_increasing_checkpoints_and_refuses_replays_over_protocol() {
        let k = keys();
        let h = "ab".repeat(32);
        let m5 = format!("tv-checkpoint-v1|5|{h}");
        let r = handle(&k, &sign_req(&m5));
        assert_eq!(r["key_id"], crypto::SIGN_KEY_ID);
        assert_eq!(B64.decode(r["signature"].as_str().unwrap()).unwrap(), k.keys.sign(m5.as_bytes()).to_vec());
        let again = handle(&k, &sign_req(&m5));
        assert!(again["error"].as_str().unwrap().contains("not above the last signed seq 5"));
        assert!(handle(&k, &sign_req(&format!("tv-checkpoint-v1|4|{h}")))["error"].is_string());
        assert!(handle(&k, &sign_req(&format!("tv-checkpoint-v1|6|{h}")))["signature"].is_string());
        // The old prefix-only check accepted this.
        assert!(handle(&k, &sign_req("tv-checkpoint-v1|7|abcd"))["error"].is_string());
    }

    #[test]
    fn rejects_oversized_input() {
        let r = handle(&keys(), &json!({"op":"wrap","aad":"a","data":B64.encode(vec![0u8; MAX_INPUT + 1])}).to_string());
        assert_eq!(r["error"], "data too large");
    }

    #[test]
    fn rejects_unknown_key_id_and_op() {
        let k = keys();
        assert!(handle(&k, r#"{"op":"unwrap","aad":"a","key_id":"other","data":"AAAA"}"#)["error"].is_string());
        assert!(handle(&k, r#"{"op":"dump_master"}"#)["error"].is_string());
        assert!(handle(&k, "not json")["error"].is_string());
    }
}
