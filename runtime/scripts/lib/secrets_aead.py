#!/usr/bin/env python3
"""AES-256-GCM primitive for Core's age-based secrets management.

Why this exists: Core's shell scripts need to produce/consume the exact
same ciphertext format ACP's `secretsCrypto.js` already uses in
production (`enc:v1:<base64(iv+tag+ct)>` / `enc:v2:<version>:<base64(...)>`),
so both repos speak one shared, interoperable format instead of two
similar-but-incompatible ones. Bash has no native AES-GCM primitive, and
`openssl enc` cannot do AEAD ciphers at all -- confirmed directly on this
host (`openssl enc -aes-256-gcm ...` -> "enc: AEAD ciphers not supported"),
and per `openssl-enc(1)`'s own manual, this is permanent upstream policy,
not a version gap. Python's `cryptography` package is the chosen mechanism
(see the unified-age-secrets-management-l1-design-2026-08-13.md design
doc, section 2 [R2]/[R3] for the full rationale and the byte-layout
reconciliation this file implements).

`age` itself is never used here. `age`'s job (decrypting the wrapped KEK
file) ends before this script is ever invoked -- this script only ever
receives an already-decrypted 32-byte KEK or DEK as a hex string, never
touches the age identity or the KEK file directly. Conflating the two
was a real design-doc error caught by an eight-hats audit; keeping them
structurally separate here is deliberate, not an oversight.

Byte layout (must match ACP's secretsCrypto.js exactly -- this is the
whole point of this file existing):
    payload = iv (12 bytes) || tag (16 bytes) || ciphertext
    stored  = base64(payload)

Python's `cryptography.hazmat.primitives.ciphers.aead.AESGCM.encrypt()`
returns `ciphertext || tag` (tag appended at the END) -- the OPPOSITE
order from the target layout. This module explicitly splits and
reorders on encrypt, and reverses that reordering on decrypt. This
detail was originally missing from the design doc itself (caught by a
scoped re-review, not the original audit) -- getting it wrong here would
silently produce ciphertext that looks valid but that Node's
`secretsCrypto.js` could never actually decrypt, or vice versa. The
cross-language round-trip test (test-secrets-aead-cross-language.sh)
is what actually proves this reconciliation is correct, not this
docstring -- read that test if you're modifying this file.

CLI usage (matches this repo's existing convention, e.g.
usersettings.py, of `python3 <script> <subcommand> <args>` invoked
directly from Bash with stdout captured):

    python3 secrets_aead.py encrypt <key-hex> <plaintext>
        -> prints base64(iv+tag+ct) to stdout

    python3 secrets_aead.py decrypt <key-hex> <base64-payload>
        -> prints plaintext to stdout

    python3 secrets_aead.py generate-key
        -> prints a fresh, random 64-hex-char (32-byte) key to stdout

Exit codes: 0 on success. 1 on any error (bad key length, malformed
base64, decryption/auth failure, wrong argument count) -- errors are
printed to stderr, never to stdout, so a caller doing
`value="$(python3 secrets_aead.py decrypt ...)"` never accidentally
captures an error message as if it were the secret.
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

    Returns base64(iv || tag || ciphertext) -- the exact layout
    ACP's secretsCrypto.js encryptSecret()/encryptWithDEK() produce.
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
    or truncated payload -- never returns corrupted plaintext. This
    mirrors ACP's decryptSecret()'s own explicit design choice: silently
    returning garbage on a wrong key/tampered ciphertext would be worse
    than a loud, immediate failure.
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

    Matches the shape loadKEK()/generateDEK() expect on the ACP side,
    and what runtime/scripts/lib/secrets.sh's generate_dek() (Core side)
    calls this for.
    """
    return secrets.token_bytes(KEY_BYTES).hex()


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        _fail(
            "usage: secrets_aead.py encrypt <key-hex> <plaintext> | "
            "decrypt <key-hex> <payload-b64> | generate-key"
        )
        return 1  # unreachable, _fail exits

    subcommand = argv[1]

    if subcommand == "generate-key":
        if len(argv) != 2:
            _fail("generate-key takes no arguments")
        print(generate_key())
        return 0

    if subcommand == "encrypt":
        if len(argv) != 4:
            _fail("usage: secrets_aead.py encrypt <key-hex> <plaintext>")
        print(encrypt(argv[2], argv[3]))
        return 0

    if subcommand == "decrypt":
        if len(argv) != 4:
            _fail("usage: secrets_aead.py decrypt <key-hex> <payload-b64>")
        print(decrypt(argv[2], argv[3]))
        return 0

    _fail(f"unknown subcommand: {subcommand!r} (expected encrypt, decrypt, or generate-key)")
    return 1  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv))
