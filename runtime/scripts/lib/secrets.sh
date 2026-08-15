#!/usr/bin/env bash
set -euo pipefail

# Age-based secrets management for dune-awakening-selfhost-docker.
#
# Implements envelope encryption (age identity -> KEK -> per-secret DEK)
# for at-rest secrets. This is stage 1 (library only, no callers yet)
# of a multi-PR rollout split out of a larger, rejected upstream PR --
# operator-facing install/usage documentation will be introduced in a
# later stage alongside the first real caller, not written upfront for
# functionality that doesn't exist yet in this narrower scope. Key
# design decisions this file embodies:
#
#   - The ciphertext format (current version: enc:v2:) is produced and
#     consumed via runtime/scripts/lib/secrets_aead.py (Python's
#     AESGCM), not via `age` or `openssl enc` directly. age's job ends
#     the moment the KEK is decrypted (load_kek, below) -- it never
#     touches the enc:v2: payload itself. This separation is
#     deliberate; do not "simplify" by routing payload encryption
#     through age (age's own on-disk format has no relationship to raw
#     AES-GCM iv+tag+ciphertext framing, and this repo's only other
#     available crypto tool, `openssl enc`, is permanently incapable of
#     AES-GCM: confirmed directly via `openssl enc -aes-256-gcm`, which
#     reports "AEAD ciphers not supported" -- a permanent upstream
#     policy, not a version gap).
#   - Any secret WRITE must follow write-temp -> fsync -> atomic-rename
#     -> write-marker-the-same-way ordering (write_secret, below) so a
#     process kill mid-write cannot produce a torn state.
#   - Migration to this mechanism is strictly opt-in, never automatic.
#     This file's read path (read_secret, below) transparently falls
#     back to the existing flat-file convention (runtime/secrets/*.txt)
#     whenever DUNE_KEK_FILE/DUNE_AGE_IDENTITY_FILE are not both set --
#     every existing operator sees zero behavior change unless they
#     explicitly opt in. A dedicated CLI command to automate the manual
#     opt-in steps is a natural follow-on, not yet implemented.
#
# This file is a library, meant to be sourced (like host-paths.sh,
# runtime-env.sh), not executed directly. It is deliberately
# credential-agnostic: nothing in this file references any specific
# secret by name. Per-secret wiring (which script reads which secret,
# via which resolver) lives in runtime-env.sh and its callers, added
# incrementally in separate, focused changes rather than all at once.
# This library has no callers as of this stage -- see this repo's own
# issue/PR history for the current status of later stages wiring up
# individual secrets.

DUNE_SECRETS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUNE_SECRETS_AEAD_PY="$DUNE_SECRETS_LIB_DIR/secrets_aead.py"

# Cache for the decrypted KEK, scoped to this process only. Never
# written back to disk -- decrypting it fresh on every process
# invocation is a deliberate design choice, not an oversight: a KEK
# cached to disk would defeat much of the point of encrypting it in
# the first place. Bash has no true private module state, so this is
# a global; callers must not read/write it directly, only through
# dune_secrets_* functions below.
_DUNE_KEK_HEX=""
_DUNE_KEK_LOADED=0

# dune_secrets_backend_configured
#   Returns 0 (true) if age-based secrets are configured for this
#   process (both DUNE_KEK_FILE and DUNE_AGE_IDENTITY_FILE set), 1
#   (false) otherwise. Callers use this to decide whether to call
#   dune_secrets_read_secret's age path or fall back to a plain
#   runtime/secrets/*.txt read themselves -- see dune_secrets_read_secret
#   below for the version that does this fallback automatically.
dune_secrets_backend_configured() {
  [ -n "${DUNE_KEK_FILE:-}" ] && [ -n "${DUNE_AGE_IDENTITY_FILE:-}" ]
}

# dune_secrets_load_kek
#   Decrypts the KEK from DUNE_KEK_FILE using DUNE_AGE_IDENTITY_FILE,
#   caches it in-process (never written to disk), and prints it as a
#   64-hex-char string to stdout. Returns 1 (and prints nothing) if the
#   backend isn't configured, the age binary is missing, the identity
#   is wrong, or the KEK file is corrupted -- a deliberate "fail soft,
#   let the caller decide" behavior, since a hard failure here would
#   need to be caught by every single caller individually rather than
#   centrally.
dune_secrets_load_kek() {
  if [ "$_DUNE_KEK_LOADED" -eq 1 ]; then
    if [ -n "$_DUNE_KEK_HEX" ]; then
      printf '%s' "$_DUNE_KEK_HEX"
      return 0
    fi
    return 1
  fi

  _DUNE_KEK_LOADED=1

  if ! dune_secrets_backend_configured; then
    return 1
  fi

  if ! command -v age >/dev/null 2>&1; then
    echo "dune secrets: age binary not found on PATH -- cannot decrypt DUNE_KEK_FILE. Install with: apt install age (see https://github.com/FiloSottile/age)." >&2
    return 1
  fi

  if [ ! -r "$DUNE_KEK_FILE" ]; then
    echo "dune secrets: DUNE_KEK_FILE ($DUNE_KEK_FILE) does not exist or is not readable." >&2
    return 1
  fi
  if [ ! -r "$DUNE_AGE_IDENTITY_FILE" ]; then
    echo "dune secrets: DUNE_AGE_IDENTITY_FILE ($DUNE_AGE_IDENTITY_FILE) does not exist or is not readable." >&2
    return 1
  fi

  local hex
  if ! hex="$(age --decrypt -i "$DUNE_AGE_IDENTITY_FILE" "$DUNE_KEK_FILE" 2>/dev/null)"; then
    echo "dune secrets: failed to decrypt DUNE_KEK_FILE with DUNE_AGE_IDENTITY_FILE -- wrong identity, or a corrupted KEK file." >&2
    return 1
  fi

  hex="$(printf '%s' "$hex" | tr -d '[:space:]')"
  if ! printf '%s' "$hex" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    echo "dune secrets: DUNE_KEK_FILE did not decrypt to a valid 64-hex-char key." >&2
    return 1
  fi

  _DUNE_KEK_HEX="$hex"
  printf '%s' "$hex"
}

# dune_secrets_generate_dek
#   Prints a fresh, random 64-hex-char (32-byte) DEK to stdout.
dune_secrets_generate_dek() {
  python3 "$DUNE_SECRETS_AEAD_PY" generate-key
}

# _dune_secrets_aead_encrypt <key-hex> <plaintext>
# _dune_secrets_aead_decrypt <key-hex> <payload-b64>
#   Thin wrappers around secrets_aead.py that pass the key and
#   plaintext/payload via STDIN, never as command-line arguments.
#
#   This is load-bearing, not a style choice: passing either value as
#   argv would make it fully visible to any local user or process able
#   to read /proc for the entire lifetime of the python3 process, via
#   /proc/<pid>/cmdline -- the exact vulnerability class
#   (GHSA-fc89-h24v-6j3x) this whole feature exists to eliminate, just
#   relocated from Docker's `-e`/`docker inspect` exposure to a CLI
#   argv exposure. `printf` below is a shell BUILTIN (confirmed via
#   `type printf`), not a separate process -- so nothing here ever
#   writes secret material to any process's own argv at any point.
_dune_secrets_aead_encrypt() {
  local key_hex="$1"
  local plaintext="$2"
  printf '%s\n%s\n' "$key_hex" "$plaintext" | python3 "$DUNE_SECRETS_AEAD_PY" encrypt
}

_dune_secrets_aead_decrypt() {
  local key_hex="$1"
  local payload_b64="$2"
  printf '%s\n%s\n' "$key_hex" "$payload_b64" | python3 "$DUNE_SECRETS_AEAD_PY" decrypt
}

# _dune_secrets_validate_name <name>
#   Every public function taking a <name> parameter (dune_secrets_encrypted_path,
#   dune_secrets_migration_marker_path, and therefore write_secret/
#   read_encrypted/read_secret which call them) MUST validate <name>
#   through this function before using it to build a filesystem path.
#
#   SECURITY: <name> is attacker-influenced the moment any future
#   caller derives it from anything less than a hardcoded literal --
#   this library is explicitly designed for many future callers, not
#   just the ones that exist today. Without this check, a <name> of
#   e.g. "../../../../tmp/evil" causes dune_secrets_encrypted_path to
#   print a path escaping runtime/secrets/ entirely, and
#   _dune_secrets_atomic_write (which has no path-containment check of
#   its own) will happily write attacker-directed content there.
#   Confirmed exploitable during a Layer 2 security-hat audit before
#   this ever shipped. Restricting <name> to a conservative allow-list
#   (lowercase letters, digits, and hyphens only, matching every real
#   secret name already in use, e.g. "funcom-token",
#   "server-login-password-secret") closes both the path-traversal
#   vector and, as a side effect, blocks the characters (quotes,
#   parens, semicolons) that made the separate RCE finding in
#   _dune_secrets_atomic_write's fsync helper exploitable via this same
#   parameter. Fix that vulnerability too, but keep this check as
#   defense in depth -- do not rely on one fix alone.
_dune_secrets_validate_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "dune secrets: rejected invalid secret name '$name' -- must match ^[a-z0-9]+(-[a-z0-9]+)*\$ (lowercase letters, digits, single hyphens between segments; no path separators, dots, or other characters)." >&2
    return 1
  fi
}

# dune_secrets_encrypted_path <name>
#   Prints the path where <name>'s age-encrypted form would live, e.g.
#   dune_secrets_encrypted_path funcom-token
#     -> runtime/secrets/funcom-token.enc
#   Returns 1 (prints nothing) if <name> fails _dune_secrets_validate_name.
dune_secrets_encrypted_path() {
  local name="$1"
  _dune_secrets_validate_name "$name" || return 1
  printf 'runtime/secrets/%s.enc\n' "$name"
}

# dune_secrets_migration_marker_path <name>
#   Prints the per-secret migration completion marker path -- one
#   marker per secret, not one global marker, so a partially-completed
#   migration batch can be resumed without reprocessing already-
#   migrated secrets. Returns 1 (prints nothing) if <name> fails
#   _dune_secrets_validate_name.
dune_secrets_migration_marker_path() {
  local name="$1"
  _dune_secrets_validate_name "$name" || return 1
  printf 'runtime/generated/.secrets-migrated/%s.done\n' "$name"
}

# dune_secrets_render_plaintext_file <path> <content> [<mode>]
#   Writes <content> to <path> as a plain (non-atomic-write) file,
#   intended for short-lived, bind-mount-source renders (e.g. a
#   container's own credential file convention) -- NOT for the
#   age-encrypted .enc secret store itself, which must use
#   _dune_secrets_atomic_write below instead.
#
#   Defends against a real, reproduced production incident: if <path>
#   already exists but is NOT a regular file (e.g. a stray directory,
#   which Docker itself can leave behind at a bind-mount source path
#   under some failure conditions), a naive
#   `rm -f` silently fails to remove it and exits non-zero, which
#   under `set -euo pipefail` aborts the CALLING script before it ever
#   reaches `docker run` -- causing a real outage of whatever
#   container depends on this render, confirmed live. This function
#   instead logs a loud, explicit warning and self-heals via `rm -rf`
#   for that specific case, so a future caller of this pattern doesn't
#   need to remember this lesson independently.
dune_secrets_render_plaintext_file() {
  local path="$1"
  local content="$2"
  local mode="${3:-600}"

  if [ -e "$path" ] && [ ! -f "$path" ]; then
    echo "dune secrets: WARNING: $path exists but is not a regular file (this indicates a prior abnormal state, e.g. a leftover directory Docker created at this path during a previous failure). Removing it automatically." >&2
    rm -rf "$path"
  else
    rm -f "$path"
  fi

  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"

  # SECURITY/CORRECTNESS: umask is process-global, not scoped to this
  # function or file. An earlier draft set `umask 077` here with no
  # restore -- since this file is sourced (not executed in a subshell),
  # that permanently changed the CALLING script's umask for its entire
  # remaining execution the moment this function was called once,
  # silently affecting every unrelated file/directory the caller
  # creates afterward. Confirmed live during a Layer 2 audit before
  # this ever shipped (a file created after calling this function
  # unexpectedly inherited mode 600 instead of the caller's own
  # default). Save and restore the caller's umask explicitly instead.
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s' "$content" > "$path"
  umask "$old_umask"

  chmod "$mode" "$path"
}

# _dune_secrets_atomic_write <final-path> <content> [<mode>]
#   Writes <content> to <final-path> via write-to-temp -> fsync ->
#   atomic rename -- the exact discipline needed to avoid a torn state
#   where a migration marker exists but the underlying secret file
#   doesn't, or vice versa. <mode> defaults to 0600 (never
#   world/group-readable) unless overridden.
#   Returns 1 (final path untouched, no torn state) if any step fails --
#   mkdir, mktemp, the content write, chmod, fsync, or the final
#   rename. Every step's exit status is checked explicitly rather than
#   assumed to succeed: an earlier draft of this function had none of
#   these checks, meaning a failure partway through (e.g. a full disk
#   during the content write, or mktemp failing because $dir doesn't
#   exist/isn't writable) was silently swallowed -- the function
#   returned 0 regardless, and callers like dune_secrets_write_secret
#   had no way to detect that the secret was never actually written.
#   Confirmed via direct reproduction during a Layer 3 integration
#   audit: a broken encryption backend caused this function to report
#   success while writing empty/malformed content to the real secret
#   path, silently destroying the original plaintext with no signal to
#   the caller. Fixed by checking every step and cleaning up any
#   partial temp file on failure.
_dune_secrets_atomic_write() {
  local final_path="$1"
  local content="$2"
  local mode="${3:-600}"

  local dir
  dir="$(dirname "$final_path")"
  if ! mkdir -p "$dir"; then
    echo "dune secrets: could not create directory '$dir' for atomic write." >&2
    return 1
  fi

  local tmp_path
  if ! tmp_path="$(mktemp "${final_path}.tmp.XXXXXX")"; then
    echo "dune secrets: could not create a temporary file for atomic write to '$final_path'." >&2
    return 1
  fi

  # printf, not echo -- avoids any risk of interpreting backslash
  # sequences or trailing-newline surprises in the secret content.
  if ! printf '%s' "$content" > "$tmp_path"; then
    echo "dune secrets: could not write content to temporary file for atomic write to '$final_path'." >&2
    rm -f -- "$tmp_path"
    return 1
  fi
  if ! chmod "$mode" "$tmp_path"; then
    echo "dune secrets: could not set permissions on temporary file for atomic write to '$final_path'." >&2
    rm -f -- "$tmp_path"
    return 1
  fi

  # fsync the temp file's contents before the rename that publishes it,
  # so a crash between fsync and rename leaves, at worst, an orphaned
  # temp file -- never a final path with truncated/partial content.
  # `sync` alone is not sufficient (it syncs the whole filesystem's
  # buffers, not specifically this file, and gives no per-file
  # ordering guarantee relative to the following rename).
  #
  # SECURITY: $tmp_path is passed as a real argv element (sys.argv[1]),
  # never interpolated into the Python source string. An earlier draft
  # of this function built the path directly into the "-c" script text
  # (e.g. os.open('$tmp_path', ...)) -- a secret `name` (which flows
  # into $final_path/$tmp_path via callers like dune_secrets_write_secret)
  # containing a single quote and Python syntax would have executed
  # arbitrary code in that draft. Confirmed exploitable during a Layer 2
  # security-hat audit before this ever shipped; fixed here by passing
  # the path as an argument Python receives as a plain string, never as
  # code it parses. Never revert to string-interpolating a caller-
  # influenced value into this (or any) -c script.
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c '
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd)
os.close(fd)
' "$tmp_path"; then
      echo "dune secrets: could not fsync temporary file for atomic write to '$final_path'." >&2
      rm -f -- "$tmp_path"
      return 1
    fi
  fi

  if ! mv -f "$tmp_path" "$final_path"; then
    echo "dune secrets: could not publish atomic write to '$final_path'." >&2
    rm -f -- "$tmp_path"
    return 1
  fi
}

# dune_secrets_write_secret <name> <plaintext>
#   Encrypts <plaintext> with a fresh DEK, wraps that DEK with the
#   current KEK, and writes both to <name>'s .enc file atomically (per
#   _dune_secrets_atomic_write above), then writes the per-secret
#   migration marker -- ONLY after the .enc write has fully succeeded,
#   so a process killed mid-write can never leave a marker pointing at
#   a missing or truncated secret file.
#
#   The on-disk .enc file format is a single line:
#     enc:v2:1:<base64(wrapped_dek)>:<base64(iv+tag+ciphertext)>
#   There is no database row to store the wrapped DEK alongside, so
#   it's stored in the same flat file, colon-separated, ahead of the
#   ciphertext payload.
#
#   Requires the KEK backend to be configured (dune_secrets_backend_configured);
#   callers must check this themselves before calling, or check this
#   function's own non-zero exit code.
dune_secrets_write_secret() {
  local name="$1"
  local plaintext="$2"

  local enc_path
  if ! enc_path="$(dune_secrets_encrypted_path "$name")"; then
    return 1
  fi

  # Call dune_secrets_load_kek as a PLAIN STATEMENT here, not via
  # $(...) command substitution -- command substitution forks a
  # subshell, and this function's in-process cache (_DUNE_KEK_HEX/
  # _DUNE_KEK_LOADED) is a real global that only that forked subshell
  # would ever see updated; the calling shell's own copy is never
  # touched, so the cache silently never took effect for any real
  # caller. Confirmed via direct reproduction during a Layer 3
  # integration audit: migrating N secrets in one script run
  # previously cost N full `age --decrypt` invocations instead of the
  # single decrypt the design intends, with no error, just needless
  # repeated work. Calling it directly here lets it populate the
  # actual calling shell's cache; the decrypted value is then read
  # from that same global rather than re-captured via a second
  # subshell-forking substitution.
  if ! dune_secrets_load_kek >/dev/null; then
    echo "dune secrets: cannot write '$name' -- KEK backend not configured or unavailable." >&2
    return 1
  fi
  local kek="$_DUNE_KEK_HEX"

  # Every step below has its exit status checked explicitly, not
  # assumed -- confirmed via a Layer 3 integration audit that an
  # earlier draft of this function silently reported success (return
  # 0) even when DEK generation or encryption failed, writing an
  # empty/malformed enc:v2:1:: line to the real secret path and
  # marking migration complete, while the original plaintext was
  # never persisted anywhere. That failure mode is exactly what every
  # check below exists to prevent: a transient failure here (a missing
  # cryptography package, disk pressure, a future bug in
  # secrets_aead.py) must abort loudly, not destroy the secret while
  # claiming success.
  local dek
  if ! dek="$(dune_secrets_generate_dek)"; then
    echo "dune secrets: could not generate a data-encryption key for '$name'." >&2
    return 1
  fi

  local wrapped_dek ciphertext
  if ! wrapped_dek="$(_dune_secrets_aead_encrypt "$kek" "$dek")"; then
    echo "dune secrets: could not wrap the data-encryption key for '$name'." >&2
    return 1
  fi
  if ! ciphertext="$(_dune_secrets_aead_encrypt "$dek" "$plaintext")"; then
    echo "dune secrets: could not encrypt the value for '$name'." >&2
    return 1
  fi

  if ! _dune_secrets_atomic_write "$enc_path" "enc:v2:1:${wrapped_dek}:${ciphertext}" 600; then
    echo "dune secrets: could not write the encrypted secret for '$name'." >&2
    return 1
  fi

  local marker_path
  # _dune_secrets_validate_name was already applied above via
  # dune_secrets_encrypted_path -- $name is known-valid by this point,
  # so this call cannot fail on the name-validation check specifically,
  # but its return code is still checked rather than assumed, per the
  # same discipline as every other call in this function.
  if ! marker_path="$(dune_secrets_migration_marker_path "$name")"; then
    return 1
  fi
  if ! _dune_secrets_atomic_write "$marker_path" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 600; then
    echo "dune secrets: wrote the encrypted secret for '$name' but could not write its migration marker." >&2
    return 1
  fi
}

# dune_secrets_read_encrypted <name>
#   Reads and decrypts <name>'s .enc file. Returns 1 (prints nothing)
#   if the .enc file doesn't exist, the KEK backend isn't configured,
#   or decryption fails -- callers should treat any non-zero return as
#   "fall back to the flat-file convention," which
#   dune_secrets_read_secret (below) does automatically.
dune_secrets_read_encrypted() {
  local name="$1"

  local enc_path
  enc_path="$(dune_secrets_encrypted_path "$name")" || return 1
  [ -r "$enc_path" ] || return 1

  # Plain statement, not $(...) -- see the write path's identical
  # comment above for why command substitution silently defeats the
  # in-process KEK cache.
  dune_secrets_load_kek >/dev/null || return 1
  local kek="$_DUNE_KEK_HEX"

  local line
  line="$(cat "$enc_path")"

  # enc:v2:1:<wrapped_dek_b64>:<ciphertext_b64>
  if [[ "$line" != enc:v2:*:*:* ]]; then
    echo "dune secrets: $enc_path is not a recognized enc:v2: payload." >&2
    return 1
  fi

  local rest wrapped_dek ciphertext
  rest="${line#enc:v2:}"
  rest="${rest#*:}"           # drop the key-version field (currently always "1")
  wrapped_dek="${rest%%:*}"
  ciphertext="${rest#*:}"

  local dek
  if ! dek="$(_dune_secrets_aead_decrypt "$kek" "$wrapped_dek" 2>/dev/null)"; then
    echo "dune secrets: failed to unwrap DEK for '$name' -- wrong KEK or corrupted $enc_path." >&2
    return 1
  fi

  _dune_secrets_aead_decrypt "$dek" "$ciphertext"
}

# dune_secrets_read_secret <name> <legacy-flat-file-path>
#   The generic "any script reads a secret" seam. Tries the
#   age-encrypted form first; if the backend isn't configured, the
#   .enc file doesn't exist yet, or decryption fails for any reason,
#   transparently falls back to reading <legacy-flat-file-path>
#   exactly as every script already does today (cat | tr -d '\r\n')
#   -- so an operator who never opts into this mechanism sees zero
#   behavior change, forever, by design (strictly opt-in, never
#   automatic).
#
#   Prints the secret value to stdout. Returns 1 if neither the
#   encrypted form nor the legacy flat file could be read.
dune_secrets_read_secret() {
  local name="$1"
  local legacy_path="$2"

  local value
  if dune_secrets_backend_configured; then
    # Deliberately NOT redirecting stderr to /dev/null here (an earlier
    # version of this function did, and it silently swallowed every
    # diagnostic from dune_secrets_load_kek/dune_secrets_read_encrypted
    # -- wrong age identity, corrupted KEK, malformed .enc file --
    # making it impossible for an operator to tell "not migrated yet"
    # apart from "migrated, but something is actually broken." The one
    # case that must stay quiet (the .enc file simply not existing yet,
    # e.g. before `dune secrets setup` has run for this secret) is
    # handled by dune_secrets_read_encrypted's own `[ -r "$enc_path" ]`
    # check returning 1 with no message at all -- there is no stderr
    # output to suppress in that specific case.
    if value="$(dune_secrets_read_encrypted "$name")"; then
      printf '%s' "$value"
      return 0
    fi
  fi

  if [ -r "$legacy_path" ]; then
    tr -d '\r\n' < "$legacy_path"
    return 0
  fi

  return 1
}
