#!/usr/bin/env python3
"""Unit tests for secrets_aead.py's AES-256-GCM encrypt/decrypt/generate-key
functions.

This is Core's equivalent of ACP's test/secretsCrypto.test.js checklist,
adapted to the smaller surface this module actually exposes (raw AEAD
primitives only -- Core's KEK/DEK orchestration and age-decrypt-the-KEK
step live in secrets.sh, not here, and are tested separately). Per the
unified-age-secrets-management-l1-design-2026-08-13.md design doc's own
standing lesson (QA-1: a "72/72 tests pass" claim that didn't actually
test the new code), this file exists specifically so secrets_aead.py is
never merged, or built upon, without its own direct test coverage.

Run directly:
    python3 runtime/scripts/lib/test_secrets_aead.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts/lib -p "test_*.py"
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import secrets_aead  # noqa: E402


VALID_KEY_HEX_A = "a" * 64  # 32 bytes, all 0xaa -- any valid 64-hex-char string works here.
VALID_KEY_HEX_B = "b" * 64


class GenerateKeyTests(unittest.TestCase):
    def test_generate_key_produces_64_hex_chars(self):
        key = secrets_aead.generate_key()
        self.assertEqual(len(key), 64)
        int(key, 16)  # raises ValueError if not valid hex -- fails the test loudly if so

    def test_generate_key_produces_different_keys_each_call(self):
        keys = {secrets_aead.generate_key() for _ in range(10)}
        self.assertEqual(len(keys), 10, "generate_key() produced a collision across 10 calls")


class EncryptDecryptRoundTripTests(unittest.TestCase):
    def test_round_trips_ascii_plaintext(self):
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "my-adapter-token")
        self.assertNotEqual(ciphertext, "my-adapter-token")
        self.assertEqual(secrets_aead.decrypt(VALID_KEY_HEX_A, ciphertext), "my-adapter-token")

    def test_round_trips_unicode_plaintext(self):
        plaintext = "special-chars-\u65e5\u672c\u8a9e-\U0001F600"
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, plaintext)
        self.assertEqual(secrets_aead.decrypt(VALID_KEY_HEX_A, ciphertext), plaintext)

    def test_round_trips_empty_string(self):
        # secrets_aead.py itself has no special-case for empty plaintext
        # (unlike ACP's encryptSecret()/encryptWithDEK(), which return ""
        # unchanged before ever calling the cipher) -- this module is the
        # raw primitive; the empty-string short-circuit belongs to whatever
        # calls this module (secrets.sh), not to the primitive itself. This
        # test documents that boundary explicitly: an empty string IS a
        # valid plaintext for this module and round-trips correctly.
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "")
        self.assertEqual(secrets_aead.decrypt(VALID_KEY_HEX_A, ciphertext), "")

    def test_ciphertext_does_not_contain_plaintext(self):
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "super-secret-value-12345")
        self.assertNotIn("super-secret-value-12345", ciphertext)

    def test_two_encryptions_of_same_plaintext_produce_different_ciphertext(self):
        # Confirms a fresh random IV is actually used per call, not a
        # fixed/zero IV -- IV reuse under GCM is catastrophic, not a
        # style nitpick.
        a = secrets_aead.encrypt(VALID_KEY_HEX_A, "same-value")
        b = secrets_aead.encrypt(VALID_KEY_HEX_A, "same-value")
        self.assertNotEqual(a, b)
        self.assertEqual(secrets_aead.decrypt(VALID_KEY_HEX_A, a), "same-value")
        self.assertEqual(secrets_aead.decrypt(VALID_KEY_HEX_A, b), "same-value")


class AuthenticationFailureTests(unittest.TestCase):
    def test_decrypting_with_wrong_key_exits_nonzero_not_corrupted_plaintext(self):
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "my-adapter-token")
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.decrypt(VALID_KEY_HEX_B, ciphertext)
        self.assertEqual(ctx.exception.code, 1)

    def test_tampered_ciphertext_is_rejected(self):
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "my-adapter-token")
        import base64
        payload = bytearray(base64.b64decode(ciphertext))
        payload[-1] ^= 0xFF  # flip a byte inside the ciphertext region
        tampered = base64.b64encode(bytes(payload)).decode("ascii")
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.decrypt(VALID_KEY_HEX_A, tampered)
        self.assertEqual(ctx.exception.code, 1)

    def test_malformed_base64_is_rejected_not_crashed_on(self):
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.decrypt(VALID_KEY_HEX_A, "not valid base64 !!! @@@")
        self.assertEqual(ctx.exception.code, 1)

    def test_truncated_payload_is_rejected(self):
        # A base64 string that decodes to fewer than IV_BYTES + TAG_BYTES
        # (28 bytes) must be rejected explicitly, not raise an unrelated
        # slice-related exception from deep inside the AESGCM call.
        import base64
        too_short = base64.b64encode(b"short").decode("ascii")
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.decrypt(VALID_KEY_HEX_A, too_short)
        self.assertEqual(ctx.exception.code, 1)


class KeyValidationTests(unittest.TestCase):
    def test_rejects_key_shorter_than_64_hex_chars(self):
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.encrypt("too-short", "value")
        self.assertEqual(ctx.exception.code, 1)

    def test_rejects_key_longer_than_64_hex_chars(self):
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.encrypt(VALID_KEY_HEX_A + "ff", "value")
        self.assertEqual(ctx.exception.code, 1)

    def test_rejects_non_hex_key(self):
        with self.assertRaises(SystemExit) as ctx:
            secrets_aead.encrypt("g" * 64, "value")  # 'g' is not a valid hex digit
        self.assertEqual(ctx.exception.code, 1)


class ByteLayoutTests(unittest.TestCase):
    """Directly verifies the iv||tag||ciphertext byte layout this module
    exists to guarantee -- the exact property the cross-language round-trip
    test (runtime/tests/test-secrets-aead-cross-language.sh) also proves
    end-to-end against real Node.js execution. These tests pin the layout
    down at the Python-only level so a regression here is caught fast,
    without needing Node installed."""

    def test_payload_length_matches_iv_plus_tag_plus_plaintext_length(self):
        # Deliberately does not hardcode the plaintext's byte length as a
        # literal in the assertion (an earlier version of this test did,
        # miscounted a "32-byte" string that was actually 31 bytes, and
        # the mistake was only caught by actually running the test --
        # exactly the kind of error a computed-length assertion makes
        # structurally impossible to repeat).
        import base64
        plaintext = "a-test-value-of-arbitrary-length"
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, plaintext)
        payload = base64.b64decode(ciphertext)
        expected_len = secrets_aead.IV_BYTES + secrets_aead.TAG_BYTES + len(plaintext.encode("utf-8"))
        self.assertEqual(len(payload), expected_len)

    def test_iv_is_not_all_zero_bytes(self):
        # A trivial but real sanity check: if secrets.token_bytes() were
        # ever accidentally replaced with a fixed/zero IV, this would
        # catch it immediately rather than relying only on the
        # "two encryptions differ" test above to notice indirectly.
        import base64
        ciphertext = secrets_aead.encrypt(VALID_KEY_HEX_A, "value")
        payload = base64.b64decode(ciphertext)
        iv = payload[:secrets_aead.IV_BYTES]
        self.assertNotEqual(iv, b"\x00" * secrets_aead.IV_BYTES)


if __name__ == "__main__":
    unittest.main()
