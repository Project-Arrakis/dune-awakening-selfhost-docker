#!/usr/bin/env python3
"""AES-256-GCM primitive for age-based secrets management.

Why this exists: Bash has no native AES-GCM, and `openssl enc` cannot
do AEAD ciphers at all (permanent upstream policy, confirmed via
`openssl enc -aes-256-gcm` -> "AEAD ciphers not supported", not a
version gap) -- so `runtime/scripts/lib/secrets.sh` shells out here
for the enc:v2: ciphertext format it produces/consumes.

`age` is never used here -- it decrypts the wrapped KEK file before
this script is ever invoked; this script only receives an
already-decrypted 32-byte KEK/DEK as a hex string. Keeping the two
concerns separate is deliberate: `age`'s on-disk format doesn't match
our raw AES-GCM framing.

Byte layout: payload = iv (12 bytes) || tag (16 bytes) || ciphertext,
stored as base64(payload). `cryptography`'s AESGCM.encrypt() returns
ciphertext||tag (tag at the END, the opposite order) -- this module
explicitly splits/reorders on encrypt and reverses it on decrypt.
Getting this wrong would silently produce ciphertext a compatible
iv||tag||ciphertext implementation could never decrypt. The
cross-language round-trip test (test-secrets-aead-cross-language.sh)
is what proves this layout, not this docstring.

CLI usage -- secret material via STDIN ONLY, never argv (see CRITICAL
below):

    python3 secrets_aead.py encrypt
        stdin: <key-hex>\n<plaintext>\n   (plaintext may contain any
               bytes except a newline -- none of this repo's current
               secrets need one; revise this protocol first if a
               future secret does)
        stdout: base64(iv+tag+ct)

    python3 secrets_aead.py decrypt
        stdin: <key-hex>\n<base64-payload>\n
        stdout: plaintext

    python3 secrets_aead.py generate-key
        stdout: a fresh, random 64-hex-char (32-byte) key

Exit codes: 0 on success, 1 on any error (bad key length, malformed
base64, decryption/auth failure, malformed stdin) -- always to
stderr, never stdout, so `value="$(... | secrets_aead.py decrypt)"`
never captures an error message as if it were the secret.

CRITICAL: taking <key-hex>/<plaintext> as plain argv (sys.argv[2/3])
would make them visible for the process's entire lifetime via
/proc/<pid>/cmdline and `ps aux` to any local user able to read /proc
-- the exact exposure class (GHSA-fc89-h24v-6j3x) this feature exists
to eliminate. Do not reintroduce an argv parameter for "convenience"
without re-reading this paragraph.
"""
from __future__ import annotations

import base64
import binascii
import secrets
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

IV_BYTES = 12
TAG_BYTES = 16
KEY_BYTES = 32


def _fail(message: str) -> None:
    print(f"secrets_aead.py: error: {message}", file=sys.stderr)
    sys.exit(1)


def _parse_key_hex(key_hex: str) -> bytes:
    key_hex = key_hex.strip()
    if len(key_hex) != KEY_BYTES * 2:
        _fail(
            f"key must be exactly {KEY_BYTES * 2} hex characters "
            f"({KEY_BYTES} bytes), got {len(key_hex)} characters"
        )
    try:
        key = bytes.fromhex(key_hex)
    except ValueError as exc:
        _fail(f"key is not valid hex: {exc}")
        raise  # unreachable, satisfies type checkers; _fail always exits
    return key


def encrypt(key_hex: str, plaintext: str) -> str:
    """Encrypts `plaintext` with AES-256-GCM under `key_hex`.

    Returns base64(iv || tag || ciphertext).
    A fresh random IV is generated on every call (required for GCM
    security -- IV reuse under the same key is catastrophic for both
    confidentiality and integrity, not merely a best practice).
    """
    key = _parse_key_hex(key_hex)
    iv = secrets.token_bytes(IV_BYTES)
    aesgcm = AESGCM(key)
    # AESGCM.encrypt() returns ciphertext || tag (tag appended at the
    # END) -- the opposite order from our target iv || tag || ciphertext
    # layout. Split and reorder explicitly; do not assume this matches
    # without the split below.
    ct_with_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    ciphertext = ct_with_tag[:-TAG_BYTES]
    tag = ct_with_tag[-TAG_BYTES:]
    payload = iv + tag + ciphertext
    return base64.b64encode(payload).decode("ascii")


def decrypt(key_hex: str, payload_b64: str) -> str:
    """Decrypts a base64(iv||tag||ciphertext) payload with AES-256-GCM.

    Raises via _fail() (exit 1) on any auth failure, malformed base64,
    or truncated payload -- never returns corrupted plaintext.
    Silently returning garbage on a wrong key/tampered ciphertext
    would be worse than a loud, immediate failure.
    """
    key = _parse_key_hex(key_hex)
    try:
        payload = base64.b64decode(payload_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        _fail(f"payload is not valid base64: {exc}")
        raise  # unreachable

    if len(payload) < IV_BYTES + TAG_BYTES:
        _fail(
            f"payload too short to contain a {IV_BYTES}-byte IV and "
            f"{TAG_BYTES}-byte tag (got {len(payload)} bytes total)"
        )

    iv = payload[:IV_BYTES]
    tag = payload[IV_BYTES:IV_BYTES + TAG_BYTES]
    ciphertext = payload[IV_BYTES + TAG_BYTES:]

    # Reverse the encrypt()-side reordering: AESGCM.decrypt() expects
    # ciphertext || tag, not our stored iv || tag || ciphertext layout.
    ct_with_tag = ciphertext + tag

    aesgcm = AESGCM(key)
    try:
        plaintext = aesgcm.decrypt(iv, ct_with_tag, None)
    except InvalidTag:
        _fail("authentication failed -- wrong key or tampered ciphertext")
        raise  # unreachable
    return plaintext.decode("utf-8")


def generate_key() -> str:
    """Generates a fresh, random 32-byte key, returned as 64 hex chars.

    Used for both KEKs and per-secret DEKs -- see
    runtime/scripts/lib/secrets.sh's generate_dek(), which calls this.
    """
    return secrets.token_bytes(KEY_BYTES).hex()


def _read_two_stdin_lines(subcommand: str) -> tuple[str, str]:
    """Reads exactly two newline-terminated values from stdin: a
    key-hex line, then a plaintext-or-payload line. Never reads from
    argv -- see the module docstring's CRITICAL note for why."""
    raw = sys.stdin.read()
    lines = raw.split("\n")
    if len(lines) < 2 or not lines[0]:
        _fail(
            f"{subcommand} expects two newline-separated values on stdin "
            f"(key-hex, then the value) -- got malformed or empty stdin"
        )
    return lines[0], lines[1]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        _fail("usage: secrets_aead.py encrypt | decrypt | generate-key (secret material via stdin, never argv)")
        return 1  # unreachable, _fail exits

    subcommand = argv[1]

    if subcommand == "generate-key":
        print(generate_key())
        return 0

    if subcommand == "encrypt":
        key_hex, plaintext = _read_two_stdin_lines("encrypt")
        print(encrypt(key_hex, plaintext))
        return 0

    if subcommand == "decrypt":
        key_hex, payload_b64 = _read_two_stdin_lines("decrypt")
        print(decrypt(key_hex, payload_b64))
        return 0

    _fail(f"unknown subcommand: {subcommand!r} (expected encrypt, decrypt, or generate-key)")
    return 1  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv))
