#!/usr/bin/env python3
"""Part of tools/restore-drill.sh: proves every stored file can be decrypted
with the master key from the backup, the same way the API does it
(apps/api/src/crypto/file-crypto.ts, key-provider.ts, keyd/src/crypto.rs):

  wrap key  = HKDF-SHA256(master, salt = empty, info = "tv-wrap-v1", 32 bytes)
  sign seed = HKDF-SHA256(master, salt = empty, info = "tv-audit-sign-v1", 32 bytes)
  aad       = "tv-blob-v1|<document_id>|<version_id>|<version_no>"
  wrapped   = nonce(12) || tag(16) || AES-256-GCM(wrap key, data key, aad)
  file      = AES-256-GCM(data key, nonce, tag, ciphertext, aad); SHA-256 must equal document_versions.sha256

Reads tab-separated rows on stdin (from psql COPY ... TO STDOUT). Plaintext
is never written anywhere. Needs the `cryptography` package
(Debian/Ubuntu: apt install python3-cryptography).

  restore-drill-decrypt.py pubkey <master.key>            prints the audit public key (base64)
  restore-drill-decrypt.py blobs  <master.key> < rows     doc_id ver_id ver_no sha256hex key_id wrapped_b64 nonce_hex tag_hex ct_b64
  restore-drill-decrypt.py totp   <master.key> < rows     user_id packed_b64
"""

import base64
import hashlib
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

WRAP_KEY_IDS = {"keyd-wrap-v1", "local-v1"}  # same algorithm; keyd in production, local provider in dev/tests


def load_master(path):
    raw = open(path, "rb").read()
    if len(raw) == 32:
        return raw
    key = base64.b64decode(raw.decode().strip())
    if len(key) != 32:
        raise SystemExit("master key is neither 32 raw bytes nor base64 of 32 bytes")
    return key


def hkdf(master, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(master)


def unwrap(wrap_key, sealed, aad):
    if len(sealed) < 28:
        raise ValueError("wrapped value too short")
    return AESGCM(wrap_key).decrypt(sealed[:12], sealed[28:] + sealed[12:28], aad)


def main():
    mode, master_path = sys.argv[1], sys.argv[2]
    master = load_master(master_path)
    if mode == "pubkey":
        seed = hkdf(master, b"tv-audit-sign-v1")
        pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        print(base64.b64encode(pub).decode())
        return 0
    wrap_key = hkdf(master, b"tv-wrap-v1")
    ok = bad = 0
    total_bytes = 0
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        f = line.split("\t")
        try:
            if mode == "blobs":
                doc_id, ver_id, ver_no, sha_hex, key_id, wrapped_b64, nonce_hex, tag_hex, ct_b64 = f
                if key_id not in WRAP_KEY_IDS:
                    raise ValueError(f"unknown key id {key_id}")
                aad = f"tv-blob-v1|{doc_id}|{ver_id}|{ver_no}".encode()
                data_key = unwrap(wrap_key, base64.b64decode(wrapped_b64), aad)
                ct = base64.b64decode(ct_b64)
                plain = AESGCM(data_key).decrypt(bytes.fromhex(nonce_hex), ct + bytes.fromhex(tag_hex), aad)
                if hashlib.sha256(plain).hexdigest() != sha_hex:
                    raise ValueError("SHA-256 of the decrypted file does not match")
                total_bytes += len(plain)
                del plain
            elif mode == "totp":
                user_id, packed_b64 = f
                packed = base64.b64decode(packed_b64)
                n = packed[0]
                key_id = packed[1:1 + n].decode()
                if key_id not in WRAP_KEY_IDS:
                    raise ValueError(f"unknown key id {key_id}")
                unwrap(wrap_key, packed[1 + n:], f"tv-totp-v1|{user_id}".encode())
            else:
                raise SystemExit(f"unknown mode {mode}")
            ok += 1
        except Exception as err:  # report every failure, keep going
            bad += 1
            print(f"FAIL {f[0]} {f[1] if len(f) > 1 else ''}: {type(err).__name__} {err}", file=sys.stderr)
    print(f"{ok} {bad} {total_bytes}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
