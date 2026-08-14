#!/usr/bin/env python3
"""AES-256-GCM primitive for age-based secrets management.

Why this exists: `runtime/scripts/lib/secrets.sh`'s shell code needs a
real AES-256-GCM implementation for the enc:v1:/enc:v2: ciphertext
format it produces/consumes. Bash has no native AES-GCM primitive, and
`openssl enc` cannot do AEAD ciphers at all -- confirmed directly
(`openssl enc -aes-256-gcm ...` -> "enc: AEAD ciphers not supported"),
and per `openssl-enc(1)`'s own manual, this is permanent upstream
policy, not a version gap. Python's `cryptography` package is the
chosen mechanism for this specific, narrow job.

`age` itself is never used here. `age`'s job (decrypting the wrapped
KEK file) ends before this script is ever invoked -- this script only
ever receives an already-decrypted 32-byte KEK or DEK as a hex string,
never touches the age identity or the KEK file directly. Keeping these
two concerns structurally separate is deliberate: age's own on-disk
format has no relationship to raw AES-GCM framing, and conflating the
two would be a real design error.

Byte layout:
    payload = iv (12 bytes) || tag (16 bytes) || ciphertext
    stored  = base64(payload)

Python's `cryptography.hazmat.primitives.ciphers.aead.AESGCM.encrypt()`
returns `ciphertext || tag` (tag appended at the END) -- the OPPOSITE
order from the target layout above. This module explicitly splits and
reorders on encrypt, and reverses that reordering on decrypt. Getting
this wrong would silently produce ciphertext that looks valid but that
a compatible implementation using the iv||tag||ciphertext ordering
could never actually decrypt, or vice versa. The cross-language
round-trip test (test-secrets-aead-cross-language.sh) is what actually
proves this byte layout is correct and portable, not this docstring --
read that test if you're modifying this file.

CLI usage: secret material is passed via STDIN, never as a command-line
argument. This is deliberate and load-bearing, not a style choice --
see the CRITICAL correction below.

    python3 secrets_aead.py encrypt
        stdin: <key-hex>\n<plaintext>\n   (plaintext may itself contain
               any bytes except a newline; if the secret could ever
               contain a newline, this protocol would need revising --
               none of this repo's current secrets do)
        stdout: base64(iv+tag+ct)

    python3 secrets_aead.py decrypt
        stdin: <key-hex>\n<base64-payload>\n
        stdout: plaintext

    python3 secrets_aead.py generate-key
        no stdin needed
        stdout: a fresh, random 64-hex-char (32-byte) key

    `runtime/scripts/lib/secrets.sh` calls this via a Bash heredoc or
    `printf '%s\n%s\n' "$key" "$value" | python3 secrets_aead.py ...` --
    `printf` is a shell BUILTIN, not a separate process, so the secret
    value is never written to any process's own argv/`/proc/<pid>/cmdline`
    at any point in that pipeline.

Exit codes: 0 on success. 1 on any error (bad key length, malformed
base64, decryption/auth failure, malformed stdin) -- errors are
printed to stderr, never to stdout, so a caller doing
`value="$(... | python3 secrets_aead.py decrypt)"` never accidentally
captures an error message as if it were the secret.

CRITICAL: taking <key-hex> and <plaintext>/<payload> as plain
positional argv arguments (`sys.argv[2]`, `sys.argv[3]`) would make
the KEK, DEK, and plaintext secret values fully visible, for the
process's entire lifetime, via `/proc/<pid>/cmdline` and `ps aux` to
any local user or process able to read `/proc` -- the exact
vulnerability class (GHSA-fc89-h24v-6j3x) this whole age-secrets
feature exists to eliminate, just relocated from Docker's
`-e`/`docker inspect` exposure to a `python3` CLI argv exposure. This
is why the CLI reads secret material from stdin exclusively; do not
reintroduce a <key-hex>/<plaintext> argv parameter for "usage"
convenience later without re-reading this paragraph.
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
