#!/usr/bin/env bash
set -euo pipefail

# Age-based secrets management for dune-awakening-selfhost-docker.
#
# Implements envelope encryption (age identity -> KEK -> per-secret DEK)
# for at-rest secrets. Meant to be sourced (like host-paths.sh,
# runtime-env.sh), not executed directly. Credential-agnostic: nothing
# here references any specific secret by name -- per-secret wiring
# lives in runtime-env.sh and its callers, added incrementally. This
# is stage 1 (library only, no callers yet) of a multi-PR rollout. The
# full internal audit history behind the design decisions below is
# maintained in this project's own fork-internal tracking (not part of
# this upstream diff); the design rationale itself is captured inline
# in the comments below instead of by reference to that external doc.
#
# Key design decisions:
#   - Ciphertext (enc:v2:) is produced/consumed via secrets_aead.py
#     (Python's AESGCM), not `age`/`openssl enc` directly. `age`'s job
#     ends once the KEK is decrypted (load_kek, below). `openssl enc`
#     cannot do AEAD ciphers at all (permanent upstream policy, not a
#     version gap) and `age`'s own format doesn't match our raw
#     iv+tag+ciphertext framing -- do not "simplify" by routing
#     payload encryption through either.
#   - Every secret WRITE follows write-temp -> fsync -> atomic-rename
#     -> write-marker (write_secret, below) so a process kill mid-write
#     cannot produce a torn state.
#   - Migration is strictly opt-in. read_secret (below) transparently
#     falls back to the legacy flat-file convention
#     (runtime/secrets/*.txt) whenever DUNE_KEK_FILE/
#     DUNE_AGE_IDENTITY_FILE aren't both set -- zero behavior change
#     for any operator who doesn't opt in.

DUNE_SECRETS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUNE_SECRETS_AEAD_PY="$DUNE_SECRETS_LIB_DIR/secrets_aead.py"

# In-process-only cache for the decrypted KEK (deliberately never
# written to disk). Bash has no private module state, so this is a
# global; callers must not read/write it directly, only through
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
#   caches it in-process, and prints it as a 64-hex-char string to
#   stdout. Returns 1 (prints nothing) if the backend isn't configured,
#   `age` is missing, the identity is wrong, or the KEK file is
#   corrupted -- callers decide how to handle failure, not this
#   function.
#
#   MUST be called as a plain statement (not via $(...)) by any caller
#   that wants the cache to actually work -- command substitution forks
#   a subshell, so cache writes never propagate back. See
#   dune_secrets_write_secret below for the call pattern to copy.
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

# _dune_secrets_aead_encrypt <key-hex> <plaintext> <aad>
# _dune_secrets_aead_decrypt <key-hex> <payload-b64> <aad>
#   Thin wrappers around secrets_aead.py, passing key, plaintext/payload,
#   and AAD via STDIN only -- never as argv (argv would be visible for
#   the process's lifetime via /proc/<pid>/cmdline, the same exposure
#   class, GHSA-fc89-h24v-6j3x, this feature exists to eliminate).
#   `printf` is a shell builtin, not a separate process, so nothing here
#   ever touches any process's argv.
#
#   <aad> binds context (secret name + format version) into the AEAD
#   auth tag without encrypting it -- see secrets_aead.py's own AAD
#   note for why: without this, a complete .enc file could be copied
#   over a different secret's .enc file and still authenticate
#   successfully under the wrong name.
_dune_secrets_aead_encrypt() {
  local key_hex="$1"
  local plaintext="$2"
  local aad="${3:-}"
  printf '%s\n%s\n%s\n' "$key_hex" "$aad" "$plaintext" | python3 "$DUNE_SECRETS_AEAD_PY" encrypt
}

_dune_secrets_aead_decrypt() {
  local key_hex="$1"
  local payload_b64="$2"
  local aad="${3:-}"
  printf '%s\n%s\n%s\n' "$key_hex" "$aad" "$payload_b64" | python3 "$DUNE_SECRETS_AEAD_PY" decrypt
}

# _dune_secrets_validate_name <name>
#   Every function taking a <name> parameter (dune_secrets_encrypted_path,
#   dune_secrets_migration_marker_path, and therefore write_secret/
#   read_encrypted/read_secret which call them) MUST validate <name>
#   through this function before using it to build a filesystem path.
#
#   SECURITY: <name> is attacker-influenced the moment any future
#   caller derives it from less than a hardcoded literal. Restricting
#   it to a conservative allow-list (lowercase letters, digits, single
#   hyphens -- matching every real secret name in use, e.g.
#   "funcom-token") closes both path traversal (a name like
#   "../../../etc/evil" escaping runtime/secrets/) and, as a side
#   effect, the RCE vector below (quotes/parens/semicolons in <name>
#   reaching a subprocess). Keep this as defense in depth even though
#   the RCE itself is also fixed independently -- do not rely on one
#   fix alone.
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
#   Writes <content> to <path> as a plain (non-atomic-write) file, for
#   short-lived, bind-mount-source renders -- NOT for the age-encrypted
#   .enc secret store itself, which must use _dune_secrets_atomic_write
#   below instead.
#
#   Self-heals if <path> already exists but is NOT a regular file (a
#   stray directory Docker can leave behind at a bind-mount source
#   under some failure conditions) -- a plain `rm -f` would silently
#   fail on that and abort the caller under `set -euo pipefail`,
#   reproduced live as a real production outage.
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

  # umask is process-global, not scoped to this function. Since this
  # file is sourced (not run in a subshell), an unrestored `umask 077`
  # would permanently change the CALLING script's umask for the rest
  # of its execution -- save and restore explicitly.
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s' "$content" > "$path"
  umask "$old_umask"

  chmod "$mode" "$path"
}

# _dune_secrets_atomic_write <final-path> <content> [<mode>]
#   Writes <content> to <final-path> via write-to-temp -> fsync ->
#   atomic rename, so a torn state (e.g. a migration marker existing
#   without its secret file, or vice versa) can never occur. <mode>
#   defaults to 0600.
#   Returns 1 (final path untouched) if ANY step fails -- mkdir,
#   mktemp, the content write, chmod, fsync, or the rename. Every
#   step's exit status is checked explicitly and any partial temp file
#   is cleaned up on failure; do not relax this to "assume success" --
#   a prior draft without these checks silently reported success while
#   destroying the original plaintext on a failed write.
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
  # never interpolated into the Python source string -- a secret name
  # containing a single quote + Python syntax would otherwise execute
  # arbitrary code (confirmed exploitable in an earlier draft). Never
  # revert to string-interpolating a caller-influenced value into this
  # (or any) -c script.
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

  # Sync the PARENT DIRECTORY's own metadata after the rename, not just
  # the file's content before it. On most POSIX filesystems, a rename(2)
  # is only durably recorded in the directory entry once the directory
  # itself is fsync'd -- without this, a crash immediately after a
  # successful rename can, on some filesystems/mount options, leave the
  # directory entry pointing at the OLD (pre-rename) name or nothing at
  # all after recovery, even though the file's own content (fsync'd
  # above) survives intact. This is required for the "power-loss
  # durability" claim in this function's own header comment to actually
  # hold -- syncing the file's content alone only guarantees the DATA
  # survives, not that the RENAME that publishes it under its final name
  # does. Not fatal if it fails (the file itself is still correctly
  # published; only the directory-entry-durability guarantee weakens),
  # so this failure is logged, not treated as an atomic-write failure.
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c '
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd)
os.close(fd)
' "$dir" 2>/dev/null; then
      echo "dune secrets: warning: could not fsync parent directory '$dir' after publishing '$final_path' -- the file itself is correctly written, but directory-entry durability across a crash is weaker than intended." >&2
    fi
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

  # Plain statement, not $(...) -- see dune_secrets_load_kek's own
  # comment above for why command substitution silently defeats the
  # in-process KEK cache.
  if ! dune_secrets_load_kek >/dev/null; then
    echo "dune secrets: cannot write '$name' -- KEK backend not configured or unavailable." >&2
    return 1
  fi
  local kek="$_DUNE_KEK_HEX"

  # Every step below has its exit status checked explicitly -- do not
  # relax this. A prior draft silently reported success even when DEK
  # generation or encryption failed, writing a malformed enc:v2:1::
  # line and discarding the original plaintext with no signal to the
  # caller.
  local dek
  if ! dek="$(dune_secrets_generate_dek)"; then
    echo "dune secrets: could not generate a data-encryption key for '$name'." >&2
    return 1
  fi

  # AAD binds the format version and secret name into both AEAD auth
  # tags below, without encrypting them -- see _dune_secrets_aead_encrypt's
  # own comment for why. Must be byte-identical to what
  # dune_secrets_read_encrypted computes on the read side, or every
  # legitimately-written secret would fail to decrypt.
  local aad="enc:v2:1:$name"

  local wrapped_dek ciphertext
  if ! wrapped_dek="$(_dune_secrets_aead_encrypt "$kek" "$dek" "$aad")"; then
    echo "dune secrets: could not wrap the data-encryption key for '$name'." >&2
    return 1
  fi
  if ! ciphertext="$(_dune_secrets_aead_encrypt "$dek" "$plaintext" "$aad")"; then
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

  local rest key_version wrapped_dek ciphertext
  rest="${line#enc:v2:}"
  key_version="${rest%%:*}"    # currently always "1"
  rest="${rest#*:}"
  wrapped_dek="${rest%%:*}"
  ciphertext="${rest#*:}"

  # Must be byte-identical to dune_secrets_write_secret's own AAD
  # construction, using the key_version actually read from this file
  # (not a hardcoded "1") so a real future key-version bump doesn't
  # silently break every already-written secret's AAD binding.
  local aad="enc:v2:${key_version}:$name"

  local dek
  if ! dek="$(_dune_secrets_aead_decrypt "$kek" "$wrapped_dek" "$aad" 2>/dev/null)"; then
    echo "dune secrets: failed to unwrap DEK for '$name' -- wrong KEK, corrupted $enc_path, or the payload belongs to a different secret." >&2
    return 1
  fi

  _dune_secrets_aead_decrypt "$dek" "$ciphertext" "$aad"
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

  # Plain statement, called BEFORE dune_secrets_read_encrypted below --
  # not because this function needs the KEK value itself, but because
  # dune_secrets_read_encrypted is invoked via $(...) command
  # substitution a few lines down, which forks a subshell. Populating
  # the cache here, in the real calling shell, means that subshell
  # inherits an already-loaded _DUNE_KEK_HEX/_DUNE_KEK_LOADED, so ITS
  # OWN internal (already-correct) plain-statement call to
  # dune_secrets_load_kek short-circuits on the cache instead of
  # invoking `age` again. Without this, every single call to this
  # function -- the one real callers actually use -- forked a fresh
  # subshell whose cache population was immediately discarded on exit,
  # so N calls to read_secret cost N age invocations regardless of the
  # lower-level caching already being correct in isolation. Confirmed
  # via the regression test below, which counts real `age` invocations
  # through THIS function specifically, not just the lower-level ones.
  if dune_secrets_backend_configured; then
    dune_secrets_load_kek >/dev/null || true
  fi

  # SECURITY: once this secret has been migrated, a decryption failure
  # (wrong KEK, corrupted ciphertext, mismatched AAD, or the .enc file
  # simply being unreadable) must fail CLOSED -- return 1, print
  # nothing -- rather than silently falling back to whatever plaintext
  # still happens to sit at <legacy_path>. Falling back here would
  # mean a corrupted, tampered, or permission-drifted .enc file is
  # invisible to the caller: the operator sees a value returned
  # successfully (the stale legacy plaintext) with no indication
  # anything is wrong, defeating the entire point of encrypting this
  # secret in the first place. Legacy fallback is only ever correct
  # for a secret that has genuinely never been migrated at all.
  #
  # "Migrated" is determined by TWO independent, readable signals, not
  # just .enc-file readability alone (fixed 2026-08-17, Requirement 20
  # Layer 2 audit, Stage 2 of the secrets-stage2-server-login design):
  # the .enc file itself, OR its per-secret migration marker
  # (dune_secrets_migration_marker_path). This belt-and-suspenders
  # check matters because the earlier version of this function only
  # consulted .enc-file readability -- if that file existed but was
  # NOT readable (permission drift after a restore, a chmod bug, a
  # root-owned file left by a container), this function fell straight
  # through to the legacy-file branch below and returned success,
  # completely defeating the fail-closed guarantee: `dune secrets
  # verify` reported "OK" on an unreadable/corrupted .enc file, and
  # `cleanup-legacy`'s own "re-verify immediately before deleting"
  # step used this exact function and would delete the last good
  # (legacy) copy while the .enc file silently sat there broken.
  # Checking the marker as a second, independent signal closes this:
  # if EITHER artifact is present and readable, this secret has
  # migration history and a decrypt failure must be a hard stop, never
  # a silent fallback. This is also the single source of truth for
  # "is this secret migrated" -- callers (e.g. runtime-env.sh's
  # resolvers, secrets-cli.sh's status/verify/cleanup-legacy commands)
  # must not reimplement this determination themselves; they should
  # rely on this function's own return value/fail-closed behavior
  # rather than duplicating the enc-or-marker check independently.
  local enc_path="" marker_path="" migrated=0
  if dune_secrets_backend_configured; then
    enc_path="$(dune_secrets_encrypted_path "$name" 2>/dev/null || true)"
    marker_path="$(dune_secrets_migration_marker_path "$name" 2>/dev/null || true)"
    if [ -n "$enc_path" ] && [ -r "$enc_path" ]; then
      migrated=1
    elif [ -n "$marker_path" ] && [ -r "$marker_path" ]; then
      migrated=1
    fi
  fi

  local value
  if [ "$migrated" = "1" ]; then
    # Deliberately NOT redirecting stderr to /dev/null here (an earlier
    # version of this function did, and it silently swallowed every
    # diagnostic from dune_secrets_load_kek/dune_secrets_read_encrypted
    # -- wrong age identity, corrupted KEK, malformed .enc file --
    # making it impossible for an operator to tell "not migrated yet"
    # apart from "migrated, but something is actually broken."
    if [ -n "$enc_path" ] && [ -r "$enc_path" ] && value="$(dune_secrets_read_encrypted "$name")"; then
      printf '%s' "$value"
      return 0
    fi
    # Migrated (by either signal) but the .enc file is missing,
    # unreadable, or failed to decrypt -- fail closed, do NOT fall
    # through to the legacy plaintext file below.
    echo "dune secrets: '$name' is migrated (per its .enc file or migration marker) but the encrypted form could not be read/decrypted -- refusing to fall back to a potentially stale legacy plaintext file. Fix the KEK/identity, check file permissions, or restore the .enc file from backup." >&2
    return 1
  fi

  if [ -r "$legacy_path" ]; then
    tr -d '\r\n' < "$legacy_path"
    return 0
  fi

  return 1
}
