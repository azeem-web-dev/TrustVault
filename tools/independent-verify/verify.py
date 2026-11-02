#!/usr/bin/env python3
"""Independent verifier for TrustVault audit export bundles.

Written from docs/VERIFY.md only, not from the Node verifier
(tools/verify-audit.mjs), so that a mistake in one is unlikely to be
repeated in the other. Python 3.9+ standard library only. If the
`cryptography` package is installed it is used for Ed25519 and ECDSA;
otherwise built-in pure-Python implementations are used (slow but correct;
fine for the few hundred checkpoints in a bundle).

    python3 verify.py bundle.json --key <base64 Ed25519 public key>
                      [--witness checkpoints.jsonl] [--rekor] [--partial]
                      [--self-consistency-only] [--json]

Exit codes (same meaning as tools/verify-audit.mjs):
    0  intact
    1  tampered or malformed
    2  only internally consistent (no --key, --rekor or --witness given)
   64  usage error
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone

EXIT_INTACT, EXIT_TAMPERED, EXIT_UNANCHORED, EXIT_USAGE = 0, 1, 2, 64

BUNDLE_FORMAT = "trustvault-audit-bundle-v1"
ZERO_HASH = "0" * 64
TAIL_GRACE_SECONDS = 5 * 60

# Published production audit key (keyd-ed25519-v1). Public by design.
PRODUCTION_KEY = "OMFkgIVZnsaXmuQkQv/Ibi8oEEEXveEbML5CtjdH+VE="

# Sigstore Rekor public log, and its public key as served at
# https://rekor.sigstore.dev/api/v1/log/publicKey (pinned).
REKOR_URL = "https://rekor.sigstore.dev"
REKOR_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
-----END PUBLIC KEY-----
"""

ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


# ---------------------------------------------------------------------------
# Spec section 2: canonical encoding and event hash
# ---------------------------------------------------------------------------

CANONICAL_FIELDS = (
    "seq", "id", "occurred_at", "actor_id", "actor_email", "action", "outcome",
    "reason", "target_type", "target_id", "document_id", "ip", "user_agent",
    "request_id", "details",
)


def encode_field(value) -> bytes:
    """NULL -> b'~'; otherwise <decimal UTF-8 byte length> ':' <UTF-8 bytes>."""
    if value is None:
        return b"~"
    if not isinstance(value, str):
        raise ValueError("every field in a bundle is a JSON string or null")
    raw = value.encode("utf-8")
    return str(len(raw)).encode("ascii") + b":" + raw


def canonical_bytes(event: dict) -> bytes:
    parts = [encode_field("tv-audit-v1")]
    for name in CANONICAL_FIELDS:
        if name not in event:
            raise ValueError(f"missing field {name}")
        parts.append(encode_field(event[name]))
    return b"".join(parts)


def event_hash(event: dict) -> str:
    prev = bytes.fromhex(event["prev_hash"])
    if len(prev) != 32:
        raise ValueError("prev_hash is not 32 bytes")
    return hashlib.sha256(prev + canonical_bytes(event)).hexdigest()


# ---------------------------------------------------------------------------
# Spec section 3: checkpoint message
# ---------------------------------------------------------------------------

def checkpoint_message(seq: str, head_hash: str) -> bytes:
    return f"tv-checkpoint-v1|{seq}|{head_hash}".encode("utf-8")


# ---------------------------------------------------------------------------
# Signature primitives: `cryptography` if present, else pure Python
# ---------------------------------------------------------------------------

try:  # pragma: no cover - depends on environment
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519

    HAVE_CRYPTOGRAPHY = True
except Exception:  # pragma: no cover
    HAVE_CRYPTOGRAPHY = False

if __import__("os").environ.get("TV_VERIFY_PURE") == "1":  # force the built-in implementations (tests)
    HAVE_CRYPTOGRAPHY = False

# --- Ed25519 (RFC 8032 section 5.1.7), pure Python -------------------------
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _ed_add(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    A = (y1 - x1) * (y2 - x2) % _P
    B = (y1 + x1) * (y2 + x2) % _P
    C = 2 * t1 * t2 * _D % _P
    D = 2 * z1 * z2 % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _ed_mul(s, p):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _ed_add(q, p)
        p = _ed_add(p, p)
        s >>= 1
    return q


def _ed_equal(a, b):
    x1, y1, z1, _ = a
    x2, y2, z2, _ = b
    return (x1 * z2 - x2 * z1) % _P == 0 and (y1 * z2 - y2 * z1) % _P == 0


def _ed_recover_x(y, sign):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def _ed_decompress(b: bytes):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _ed_recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


_GY = 4 * pow(5, _P - 2, _P) % _P
_G = (_ed_recover_x(_GY, 0), _GY, 1, _ed_recover_x(_GY, 0) * _GY % _P)


def _ed25519_verify_pure(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    A = _ed_decompress(public)
    R = _ed_decompress(signature[:32])
    if A is None or R is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % _L
    return _ed_equal(_ed_mul(s, _G), _ed_add(R, _ed_mul(h, A)))


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if HAVE_CRYPTOGRAPHY:
        try:
            ed25519.Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
            return True
        except (InvalidSignature, ValueError):
            return False
    return _ed25519_verify_pure(public, message, signature)


# --- ECDSA P-256 / SHA-256 (for Rekor receipts), pure Python ---------------
_EC_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_EC_A = _EC_P - 3
_EC_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_EC_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
         0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def _ec_add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % _EC_P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + _EC_A) * pow(2 * p[1], _EC_P - 2, _EC_P) % _EC_P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], _EC_P - 2, _EC_P) % _EC_P
    x = (lam * lam - p[0] - q[0]) % _EC_P
    return (x, (lam * (p[0] - x) - p[1]) % _EC_P)


def _ec_mul(k, p):
    r = None
    while k:
        if k & 1:
            r = _ec_add(r, p)
        p = _ec_add(p, p)
        k >>= 1
    return r


def _der_read(buf: bytes, i: int):
    tag = buf[i]
    length = buf[i + 1]
    i += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(buf[i:i + n], "big")
        i += n
    return tag, buf[i:i + length], i + length


def _p256_point_from_spki(der: bytes):
    # SEQUENCE { SEQUENCE { algId, curve }, BIT STRING 00 04 X Y }
    _, body, _ = _der_read(der, 0)
    _, _, j = _der_read(body, 0)
    tag, bits, _ = _der_read(body, j)
    if tag != 0x03 or bits[0] != 0 or bits[1] != 4 or len(bits) != 66:
        raise ValueError("not an uncompressed P-256 key")
    return int.from_bytes(bits[2:34], "big"), int.from_bytes(bits[34:66], "big")


def _ecdsa_p256_verify_pure(spki_der: bytes, message: bytes, der_sig: bytes) -> bool:
    try:
        Q = _p256_point_from_spki(spki_der)
        tag, seq, _ = _der_read(der_sig, 0)
        if tag != 0x30:
            return False
        _, rb, k = _der_read(seq, 0)
        _, sb, _ = _der_read(seq, k)
        r, s = int.from_bytes(rb, "big"), int.from_bytes(sb, "big")
    except Exception:
        return False
    if not (1 <= r < _EC_N and 1 <= s < _EC_N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, _EC_N - 2, _EC_N)
    pt = _ec_add(_ec_mul(e * w % _EC_N, _EC_G), _ec_mul(r * w % _EC_N, Q))
    return pt is not None and pt[0] % _EC_N == r


def pem_to_der(pem: str) -> bytes:
    lines = [l for l in pem.strip().splitlines() if not l.startswith("-----")]
    return base64.b64decode("".join(lines))


def ecdsa_p256_verify(spki_der: bytes, message: bytes, der_sig: bytes) -> bool:
    if HAVE_CRYPTOGRAPHY:
        try:
            key = serialization.load_der_public_key(spki_der)
            key.verify(der_sig, message, ec.ECDSA(hashes.SHA256()))
            return True
        except (InvalidSignature, ValueError):
            return False
    return _ecdsa_p256_verify_pure(spki_der, message, der_sig)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        v = value.replace("Z", "+00:00")
        t = datetime.fromisoformat(v)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.timestamp()
    except ValueError:
        return None


def parse_seq(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def b64(value) -> bytes:
    return base64.b64decode(value or "", validate=True)


def ed25519_pem(public_b64: str) -> str:
    der = ED25519_SPKI_PREFIX + base64.b64decode(public_b64)
    return "-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(der).decode() + "\n-----END PUBLIC KEY-----\n"


# ---------------------------------------------------------------------------
# Spec section 5: bundle verification rules
# ---------------------------------------------------------------------------

def verify_bundle(bundle, pinned_key=None, witness=None, partial=False):
    problems, warnings = [], []
    if not isinstance(bundle, dict):
        return {"ok": False, "problems": ["bundle is not a JSON object"], "warnings": []}
    if bundle.get("format") != BUNDLE_FORMAT:
        problems.append("unknown bundle format")
    events = bundle.get("events") or []
    if not events:
        problems.append("bundle has no events")

    # Rule B1: start of the log
    from_genesis = bool(events) and events[0].get("prev_hash") == ZERO_HASH
    gph = bundle.get("genesisPrevHash")
    if gph is not None and events and gph != events[0].get("prev_hash"):
        problems.append("genesisPrevHash is set but the first event does not link to it")
    if events and not from_genesis and not partial:
        problems.append(f"bundle starts at seq {events[0].get('seq')}, not at the beginning of the log (use --partial for a deliberate range)")

    # Rules B2-B4: hashes, links, order
    chain = {}
    prev_hash, prev_seq = None, None
    for e in events:
        seq = parse_seq(e.get("seq"))
        if seq is None:
            problems.append(f"event with invalid seq {e.get('seq')!r}")
            continue
        if prev_seq is not None and seq <= prev_seq:
            problems.append(f"seq {seq}: not strictly increasing")
        if prev_hash is not None and e.get("prev_hash") != prev_hash:
            problems.append(f"seq {seq}: prev_hash does not equal the previous event's hash")
        try:
            recomputed = event_hash(e)
        except (ValueError, TypeError, AttributeError) as err:
            recomputed = None
            problems.append(f"seq {seq}: malformed event ({err})")
        if recomputed is not None and recomputed != e.get("hash"):
            problems.append(f"seq {seq}: hash does not match its contents")
        chain[seq] = e.get("hash")
        prev_hash, prev_seq = e.get("hash"), seq
    last_seq = prev_seq

    # Rule C1: which key
    sk = bundle.get("signingKey") or {}
    bundle_key = sk.get("publicKey")
    if pinned_key and bundle_key != pinned_key:
        problems.append(f"bundle signing key {bundle_key} is not the pinned key {pinned_key}")
    key_b64 = pinned_key or bundle_key
    try:
        key_raw = base64.b64decode(key_b64 or "", validate=True)
        if len(key_raw) != 32:
            raise ValueError
    except Exception:
        key_raw = None
        problems.append("invalid signing key")

    # Rules C2-C4: checkpoints
    checkpoints = bundle.get("checkpoints") or []
    if not checkpoints:
        problems.append("bundle has no signed checkpoints")
    cp_by_seq = {}
    newest = None
    for c in checkpoints:
        seq = parse_seq(c.get("seq"))
        if seq is None:
            problems.append(f"checkpoint with invalid seq {c.get('seq')!r}")
            continue
        cp_by_seq[seq] = c
        if seq not in chain:
            problems.append(f"checkpoint {seq}: no event with that seq in the bundle")
        elif chain[seq] != c.get("headHash"):
            problems.append(f"checkpoint {seq}: head hash differs from the chain")
        if key_raw is not None:
            try:
                sig = b64(c.get("signature"))
                good = ed25519_verify(key_raw, checkpoint_message(str(seq), str(c.get("headHash"))), sig)
            except Exception:
                good = False
            if not good:
                problems.append(f"checkpoint {seq}: bad signature")
        if newest is None or seq > parse_seq(newest["seq"]):
            newest = c

    # Rule C5: unprotected tail
    exported_at = parse_time(bundle.get("exportedAt"))
    if exported_at is None:
        problems.append("bundle has no valid exportedAt")
    if newest is not None and last_seq is not None and last_seq > parse_seq(newest["seq"]):
        n_tail = sum(1 for e in events if (parse_seq(e.get("seq")) or 0) > parse_seq(newest["seq"]))
        signed_at = parse_time(newest.get("createdAt"))
        msg = f"{n_tail} event(s) after checkpoint {newest['seq']} are not covered by a signature"
        if exported_at is not None and signed_at is not None and exported_at - signed_at <= TAIL_GRACE_SECONDS:
            warnings.append(msg + " (exported within 5 minutes of that checkpoint; normal)")
        else:
            problems.append(msg + ", and the export is more than 5 minutes after that checkpoint was signed")

    # Rule W1-W3: GitHub witness records
    witness_matched, witness_beyond = 0, 0
    for w in witness or []:
        seq = parse_seq(w.get("seq"))
        if seq is None:
            problems.append(f"witness record with invalid seq {w.get('seq')!r}")
            continue
        if seq in chain:
            if chain[seq] != w.get("headHash"):
                problems.append(f"seq {seq}: differs from the head the witness recorded at {w.get('witnessedAt')}")
            else:
                witness_matched += 1
        seen = parse_time(w.get("witnessedAt"))
        if seen is None or exported_at is None or seen >= exported_at:
            continue
        if from_genesis and not partial:
            if last_seq is not None and seq > last_seq:
                problems.append(f"witness has checkpoint {seq} (seen {w.get('witnessedAt')}) beyond the end of this bundle: history was cut off or rewritten")
            elif seq not in cp_by_seq:
                problems.append(f"witness has checkpoint {seq} (seen {w.get('witnessedAt')}) that is missing from this bundle")
            elif cp_by_seq[seq].get("headHash") != w.get("headHash"):
                problems.append(f"checkpoint {seq}: differs from the witness record")
        elif last_seq is not None and seq > last_seq:
            witness_beyond += 1
    if witness_beyond:
        warnings.append(f"{witness_beyond} witnessed checkpoint(s) lie beyond this partial bundle and were not checked")

    return {
        "ok": not problems, "problems": problems, "warnings": warnings,
        "events": len(events), "checkpoints": len(checkpoints), "witnessMatched": witness_matched,
        "fromGenesis": from_genesis, "firstSeq": events[0].get("seq") if events else None,
        "lastSeq": last_seq, "exportedAt": exported_at, "bundleKey": bundle_key,
    }


# ---------------------------------------------------------------------------
# Spec section 6: Sigstore Rekor
# ---------------------------------------------------------------------------

def _canonical_json(v) -> str:
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + _canonical_json(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(_canonical_json(x) for x in v) + "]"
    return json.dumps(v)


def parse_rekor_entry(uuid, entry, public_b64, rekor_pem=REKOR_PUBLIC_KEY_PEM):
    """Returns {uuid, logIndex, integratedTime, digest} or None if the receipt is not valid for our key."""
    try:
        rekor_der = pem_to_der(rekor_pem)
        if hashlib.sha256(rekor_der).hexdigest() != entry["logID"]:
            return None
        payload = _canonical_json({"body": entry["body"], "integratedTime": entry["integratedTime"],
                                   "logID": entry["logID"], "logIndex": entry["logIndex"]}).encode()
        set_sig = base64.b64decode(entry["verification"]["signedEntryTimestamp"])
        if not ecdsa_p256_verify(rekor_der, payload, set_sig):
            return None
        body = json.loads(base64.b64decode(entry["body"]))
        if body.get("kind") != "rekord":
            return None
        spec = body["spec"]
        if spec["data"]["hash"]["algorithm"] != "sha256":
            return None
        pem = base64.b64decode(spec["signature"]["publicKey"]["content"]).decode()
        if "".join(pem.split()) != "".join(ed25519_pem(public_b64).split()):
            return None
        return {"uuid": uuid, "logIndex": entry["logIndex"], "integratedTime": entry["integratedTime"],
                "digest": spec["data"]["hash"]["value"]}
    except Exception:
        return None


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "accept": "application/json",
                                          "user-agent": "trustvault-independent-verify"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fetch_rekor_entries(public_b64, url=REKOR_URL):
    pem_b64 = base64.b64encode(ed25519_pem(public_b64).encode()).decode()
    uuids = _post(f"{url}/api/v1/index/retrieve", {"publicKey": {"format": "x509", "content": pem_b64}})
    uuids = sorted({u for u in uuids if isinstance(u, str)})
    entries, invalid = [], []
    for i in range(0, len(uuids), 10):
        for obj in _post(f"{url}/api/v1/log/entries/retrieve", {"entryUUIDs": uuids[i:i + 10]}):
            for uuid, e in obj.items():
                p = parse_rekor_entry(uuid, e, public_b64)
                (entries.append(p) if p else invalid.append(uuid))
    seen, unique = set(), []
    for e in sorted(entries, key=lambda x: x["logIndex"]):
        if e["digest"] not in seen:
            seen.add(e["digest"])
            unique.append(e)
    return unique, invalid


def rekor_check(bundle, entries, partial=False):
    """entries: [{logIndex, integratedTime (unix seconds), digest}]."""
    problems, warnings = [], []
    events = bundle.get("events") or []
    from_genesis = bool(events) and events[0].get("prev_hash") == ZERO_HASH
    exported_at = parse_time(bundle.get("exportedAt"))
    digest = lambda seq, h: hashlib.sha256(checkpoint_message(str(seq), str(h))).hexdigest()
    cp_digests = {digest(c.get("seq"), c.get("headHash")): c.get("seq") for c in bundle.get("checkpoints") or []}
    ev_digests = {digest(e.get("seq"), e.get("hash")): e.get("seq") for e in events}
    anchored = [e for e in entries if e["digest"] in cp_digests]
    if not anchored:
        problems.append("none of the bundle's checkpoints is in the public log")
    newest_anchor = max((e["logIndex"] for e in anchored), default=None)
    outside, after = 0, 0
    for e in entries:
        if e["digest"] in cp_digests:
            continue
        if exported_at is not None and e["integratedTime"] >= exported_at:
            after += 1
            continue
        as_event = ev_digests.get(e["digest"])
        if from_genesis and not partial:
            if as_event:
                problems.append(f"public log entry {e['logIndex']} is the checkpoint of seq {as_event}, which this bundle lacks")
            else:
                problems.append(f"public log entry {e['logIndex']} matches nothing in this bundle: history was cut off or rewritten")
        elif as_event:
            continue
        elif from_genesis and newest_anchor is not None and e["logIndex"] < newest_anchor:
            problems.append(f"public log entry {e['logIndex']} matches no event in this bundle")
        else:
            outside += 1
    if outside:
        warnings.append(f"{outside} public log entries lie outside this partial bundle and were not checked")
    return {"ok": not problems, "problems": problems, "warnings": warnings, "anchored": len(anchored), "afterExport": after}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

USAGE = ("usage: verify.py <bundle.json> [--key <base64>] [--witness checkpoints.jsonl] [--rekor] "
         "[--rekor-entries file.json] [--partial] [--self-consistency-only] [--json]")


def parse_args(argv):
    opts = {"key": None, "witness": None, "rekor": False, "rekor_entries": None, "partial": False,
            "self_only": False, "json": False, "file": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--key", "--witness", "--rekor-entries"):
            if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                return None
            opts[a[2:].replace("-", "_")] = argv[i + 1]
            i += 2
            continue
        if a == "--rekor":
            opts["rekor"] = True
        elif a == "--partial":
            opts["partial"] = True
        elif a == "--self-consistency-only":
            opts["self_only"] = True
        elif a == "--json":
            opts["json"] = True
        elif a.startswith("--") or opts["file"]:
            return None
        else:
            opts["file"] = a
        i += 1
    return opts if opts["file"] else None


def main(argv):
    opts = parse_args(argv)
    if opts is None:
        print(USAGE, file=sys.stderr)
        return EXIT_USAGE
    try:
        with open(opts["file"], encoding="utf-8") as f:
            bundle = json.load(f)
        witness = None
        if opts["witness"]:
            with open(opts["witness"], encoding="utf-8") as f:
                witness = [json.loads(l) for l in f if l.strip()]
    except Exception as err:
        print(f"TAMPERED: cannot read input: {err}")
        return EXIT_TAMPERED

    r = verify_bundle(bundle, opts["key"], witness, opts["partial"])
    problems, warnings = list(r["problems"]), list(r["warnings"])
    if not opts["key"] and r.get("bundleKey") and r["bundleKey"] != PRODUCTION_KEY:
        warnings.append("no --key given and the bundle's key is not the published production key")

    use_rekor = opts["rekor"] or opts["rekor_entries"]
    if use_rekor and isinstance(bundle, dict):
        key = opts["key"] or (bundle.get("signingKey") or {}).get("publicKey")
        try:
            if opts["rekor_entries"]:  # offline: entries already fetched (test or air-gapped use)
                with open(opts["rekor_entries"], encoding="utf-8") as f:
                    raw = json.load(f)
                entries = [dict(e, integratedTime=parse_time(e["integratedTime"]) if isinstance(e["integratedTime"], str) else e["integratedTime"]) for e in raw]
                invalid = []
            else:
                entries, invalid = fetch_rekor_entries(key)
            rk = rekor_check(bundle, entries, opts["partial"])
            problems += rk["problems"] + [f"public log entry {u} has an invalid receipt" for u in invalid]
            warnings += rk["warnings"]
        except Exception as err:
            problems.append(f"could not check the public log: {err}")

    anchored = bool(opts["key"] or use_rekor or witness)
    if problems:
        code, verdict = EXIT_TAMPERED, "TAMPERED"
    elif anchored:
        code, verdict = EXIT_INTACT, "INTACT"
    elif opts["self_only"]:
        code, verdict = EXIT_INTACT, "CONSISTENT"
    else:
        code, verdict = EXIT_UNANCHORED, "UNVERIFIED"

    if opts["json"]:
        print(json.dumps({"verdict": verdict, "exit": code, "problems": problems, "warnings": warnings,
                          "events": r.get("events"), "checkpoints": r.get("checkpoints"),
                          "witnessMatched": r.get("witnessMatched"), "crypto": "cryptography" if HAVE_CRYPTOGRAPHY else "pure-python"}))
        return code
    for w in warnings:
        print(f"WARNING: {w}")
    if problems:
        print(f"TAMPERED: {len(problems)} problem(s)")
        for p in problems:
            print(f" - {p}")
    else:
        extra = f", {r['witnessMatched']} witness record(s) match" if witness else ""
        print(f"{verdict}: {r['events']} events, {r['checkpoints']} signed checkpoints{extra}.")
        if verdict == "UNVERIFIED":
            print("Internally consistent only: nothing ties it to the real key. Pass --key "
                  f"{PRODUCTION_KEY} (or --rekor / --witness), or --self-consistency-only to accept this.")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
