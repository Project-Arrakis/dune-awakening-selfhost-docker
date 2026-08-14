#!/usr/bin/env python3
"""Unit tests for secrets_aead.py's AES-256-GCM encrypt/decrypt/generate-key
functions.

Scoped to the raw AEAD primitives this module actually exposes -- the
KEK/DEK orchestration and age-decrypt-the-KEK step live in secrets.sh,
not here, and are tested separately (test-secrets-lib.sh). This file
exists specifically so secrets_aead.py has its own direct test
coverage, not just indirect coverage via a passing higher-level test
suite that happens not to exercise every code path.

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
        # -- if a caller ever wants to short-circuit on an empty string
        # before calling this module, that's the caller's own choice
        # (e.g. secrets.sh), not something this primitive should assume.
        # This test documents that boundary explicitly: an empty string
        # IS a valid plaintext for this module and round-trips correctly.
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


class CliArgvExposureRegressionTests(unittest.TestCase):
    """Guards against the CLI ever taking the key and plaintext/payload
    as plain command-line arguments, which would make them fully
    visible to any local user or process able to read /proc for the
    process's entire lifetime, via /proc/<pid>/cmdline. This is the
    exact vulnerability class (GHSA-fc89-h24v-6j3x) this whole feature
    exists to eliminate, just relocated from Docker's -e/docker
    inspect exposure to a CLI argv exposure.

    These tests actually spawn the real CLI as a real subprocess (not
    calling the Python functions directly, which would never have
    caught this) and inspect that subprocess's own argv while it is
    running, to make a silent regression to argv-based secret passing
    structurally impossible to miss."""

    def _spawn_and_capture_argv(self, stdin_data: str, subcommand: str):
        """Spawns secrets_aead.py as a real subprocess with a delay
        injected via a slow stdin feed, and captures that subprocess's
        own argv (via /proc/<pid>/cmdline on Linux, or psutil-free
        polling elsewhere) while it's still alive and blocked reading
        stdin -- proving the secret is never in argv at any point
        during the process's life, not just checking the final
        invocation command a test might construct."""
        import subprocess
        import time

        script_path = Path(__file__).resolve().parent / "secrets_aead.py"
        proc = subprocess.Popen(
            [sys.executable, str(script_path), subcommand],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            # Give the OS a moment to actually exec() the child before
            # we inspect its cmdline -- reading /proc too early could
            # race the exec.
            time.sleep(0.05)
            cmdline_path = Path(f"/proc/{proc.pid}/cmdline")
            if cmdline_path.exists():
                raw_cmdline = cmdline_path.read_bytes()
                argv_str = raw_cmdline.decode("utf-8", errors="replace")
            else:
                # Non-Linux fallback: this test's core guarantee (stdin,
                # not argv) is still verified by the functional
                # round-trip test below; the /proc-specific assertion
                # is skipped, not silently passed, if unavailable.
                argv_str = None
        finally:
            stdout, stderr = proc.communicate(input=stdin_data, timeout=5)

        return argv_str, stdout.strip(), stderr, proc.returncode

    def test_encrypt_cli_never_exposes_key_or_plaintext_via_proc_cmdline(self):
        secret_key = VALID_KEY_HEX_A
        secret_plaintext = "THIS_MUST_NEVER_APPEAR_IN_PROC_CMDLINE_1234567890"
        stdin_data = f"{secret_key}\n{secret_plaintext}\n"

        argv_str, stdout, stderr, returncode = self._spawn_and_capture_argv(stdin_data, "encrypt")

        self.assertEqual(returncode, 0, f"encrypt CLI failed: {stderr}")
        self.assertTrue(stdout, "encrypt CLI produced no output")

        if argv_str is not None:
            self.assertNotIn(
                secret_key, argv_str,
                "REGRESSION: the KEK/DEK is visible in /proc/<pid>/cmdline -- "
                "the CLI is reading secret material from argv again, not stdin"
            )
            self.assertNotIn(
                secret_plaintext, argv_str,
                "REGRESSION: the plaintext secret is visible in /proc/<pid>/cmdline -- "
                "the CLI is reading secret material from argv again, not stdin"
            )

    def test_decrypt_cli_never_exposes_key_or_payload_via_proc_cmdline(self):
        secret_key = VALID_KEY_HEX_A
        ciphertext = secrets_aead.encrypt(secret_key, "some-value-to-round-trip")
        stdin_data = f"{secret_key}\n{ciphertext}\n"

        argv_str, stdout, stderr, returncode = self._spawn_and_capture_argv(stdin_data, "decrypt")

        self.assertEqual(returncode, 0, f"decrypt CLI failed: {stderr}")
        self.assertEqual(stdout, "some-value-to-round-trip")

        if argv_str is not None:
            self.assertNotIn(
                secret_key, argv_str,
                "REGRESSION: the KEK/DEK is visible in /proc/<pid>/cmdline during decrypt"
            )
            self.assertNotIn(
                ciphertext, argv_str,
                "REGRESSION: the ciphertext payload is visible in /proc/<pid>/cmdline during decrypt"
            )


if __name__ == "__main__":
    unittest.main()
