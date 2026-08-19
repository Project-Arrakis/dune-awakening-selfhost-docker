#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Cross-language round-trip proof for the enc:v2: ciphertext format
# produced/consumed by runtime/scripts/lib/secrets_aead.py
# (Python/AESGCM).
#
# Why this test exists: a design that merely ASSERTS a given byte
# layout (iv[12] || tag[16] || ciphertext, AES-256-GCM, authTagLength
# pinned to 16) is correct and portable, without ever verifying it
# against an independent implementation, is an unproven claim, not a
# fact. This test is the actual verification -- it reimplements the
# same byte layout inline in Node (using Node's own built-in `crypto`
# module, no external dependencies) and round-trips real ciphertext
# between the two independent implementations in both directions,
# plus a tamper-detection check. If this test is ever deleted or
# starts silently passing without exercising both languages, the
# interoperability claim reverts to being unproven again.

command -v node >/dev/null 2>&1 || fail "node is required for this test but was not found on PATH"
command -v python3 >/dev/null 2>&1 || fail "python3 is required for this test but was not found on PATH"

if ! python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" >/dev/null 2>&1; then
  fail "python3's 'cryptography' package is required but not installed (pip install cryptography)"
fi

SECRETS_AEAD="$repo_root/runtime/scripts/lib/secrets_aead.py"
[ -f "$SECRETS_AEAD" ] || fail "$SECRETS_AEAD not found"

# ---------------------------------------------------------------------------
# Direction 1: Python encrypts, Node decrypts.
# ---------------------------------------------------------------------------

key_hex="$(python3 "$SECRETS_AEAD" generate-key)"
[ "${#key_hex}" -eq 64 ] || fail "generate-key did not produce a 64-hex-char key (got ${#key_hex} chars)"

# AAD (associated data) bound into the auth tag but never encrypted --
# secrets.sh passes "enc:v2:<version>:<secret-name>" here; this test
# uses a representative fixed value to prove the AAD binding itself is
# portable across implementations, not just the ciphertext bytes.
test_aad="enc:v2:1:cross-language-test-secret"

plaintext_py_to_node="cross-language-test-value-from-python-\$pecial-chars-日本語"
# secrets_aead.py's encrypt/decrypt subcommands read key + AAD + value
# from stdin, never argv -- see secrets_aead.py's own module docstring
# for why (a real, reproduced /proc/<pid>/cmdline exposure this was
# fixed to close). `printf` is a shell builtin, not a separate process.
ciphertext_from_python="$(printf '%s\n%s\n%s\n' "$key_hex" "$test_aad" "$plaintext_py_to_node" | python3 "$SECRETS_AEAD" encrypt)"
[ -n "$ciphertext_from_python" ] || fail "python3 encrypt produced empty output"

decrypted_by_node="$(node -e '
const [ , keyHex, payloadB64, aad ] = process.argv;
const { createDecipheriv } = require("node:crypto");
const key = Buffer.from(keyHex, "hex");
const payload = Buffer.from(payloadB64, "base64");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const iv = payload.subarray(0, IV_BYTES);
const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
decipher.setAAD(Buffer.from(aad, "utf8"));
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
process.stdout.write(plaintext.toString("utf8"));
' "$key_hex" "$ciphertext_from_python" "$test_aad")"

[ "$decrypted_by_node" = "$plaintext_py_to_node" ] || fail \
  "Python-encrypted payload did not decrypt correctly in Node. Expected: '$plaintext_py_to_node', got: '$decrypted_by_node'"

echo "OK: Python encrypt -> Node decrypt round-trip succeeded"

# ---------------------------------------------------------------------------
# Direction 2: Node encrypts, Python decrypts.
# ---------------------------------------------------------------------------

plaintext_node_to_py="cross-language-test-value-from-node-\$pecial-chars-日本語"

ciphertext_from_node="$(node -e '
const [ , keyHex, plaintext, aad ] = process.argv;
const { createCipheriv, randomBytes } = require("node:crypto");
const key = Buffer.from(keyHex, "hex");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const iv = randomBytes(IV_BYTES);
const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
cipher.setAAD(Buffer.from(aad, "utf8"));
const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
const payload = Buffer.concat([iv, tag, ciphertext]);
process.stdout.write(payload.toString("base64"));
' "$key_hex" "$plaintext_node_to_py" "$test_aad")"

[ -n "$ciphertext_from_node" ] || fail "node encrypt produced empty output"

decrypted_by_python="$(printf '%s\n%s\n%s\n' "$key_hex" "$test_aad" "$ciphertext_from_node" | python3 "$SECRETS_AEAD" decrypt)"

[ "$decrypted_by_python" = "$plaintext_node_to_py" ] || fail \
  "Node-encrypted payload did not decrypt correctly in Python. Expected: '$plaintext_node_to_py', got: '$decrypted_by_python'"

echo "OK: Node encrypt -> Python decrypt round-trip succeeded"

# ---------------------------------------------------------------------------
# Negative test: tampering with either side's ciphertext must be detected
# by the other side's decrypt (auth tag failure), not silently accepted.
# ---------------------------------------------------------------------------

tampered_payload="$(python3 -c "
import base64
payload = base64.b64decode('$ciphertext_from_python')
tampered = bytearray(payload)
tampered[-1] ^= 0xff
print(base64.b64encode(bytes(tampered)).decode('ascii'))
")"

if node -e '
const [ , keyHex, payloadB64, aad ] = process.argv;
const { createDecipheriv } = require("node:crypto");
const key = Buffer.from(keyHex, "hex");
const payload = Buffer.from(payloadB64, "base64");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const iv = payload.subarray(0, IV_BYTES);
const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
decipher.setAAD(Buffer.from(aad, "utf8"));
decipher.setAuthTag(tag);
Buffer.concat([decipher.update(ciphertext), decipher.final()]);
' "$key_hex" "$tampered_payload" "$test_aad" 2>/dev/null; then
  fail "Node decrypt accepted a tampered Python-encrypted payload -- authentication is not working across languages"
fi

echo "OK: tampered cross-language payload correctly rejected by Node's auth-tag check"

# ---------------------------------------------------------------------------
# Negative test: a MISMATCHED AAD (correct key, correct untampered
# ciphertext, wrong associated data) must also be rejected across
# languages -- direct cross-language coverage for the AAD-binding fix
# (a complete .enc payload swapped between two different secrets would
# otherwise still authenticate under the wrong name).
# ---------------------------------------------------------------------------

if node -e '
const [ , keyHex, payloadB64, wrongAad ] = process.argv;
const { createDecipheriv } = require("node:crypto");
const key = Buffer.from(keyHex, "hex");
const payload = Buffer.from(payloadB64, "base64");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const iv = payload.subarray(0, IV_BYTES);
const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
decipher.setAAD(Buffer.from(wrongAad, "utf8"));
decipher.setAuthTag(tag);
Buffer.concat([decipher.update(ciphertext), decipher.final()]);
' "$key_hex" "$ciphertext_from_python" "enc:v2:1:a-completely-different-secret-name" 2>/dev/null; then
  fail "Node decrypt accepted a Python-encrypted payload under the WRONG AAD -- AAD binding is not working across languages"
fi

echo "OK: mismatched AAD correctly rejected across languages (Python-encrypted, Node-decrypted under wrong AAD)"

echo "All cross-language AES-256-GCM round-trip checks passed."
