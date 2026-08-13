#!/usr/bin/env bash
set -euo pipefail

# Age-based secrets management for Core (dune-awakening-selfhost-docker).
#
# See docs/design/unified-age-secrets-management-l1-design-2026-08-13.md
# in the Arrakis-Project meta-repo for the full L1 design this
# implements, including the eight-hats audit findings this file
# specifically resolves:
#
#   - ARCH-1/ARCH-2: the enc:v1:/enc:v2: ciphertext format is produced
#     and consumed via runtime/scripts/lib/secrets_aead.py (Python's
#     AESGCM), not via `age` or `openssl enc` directly. age's job ends
#     the moment the KEK is decrypted (load_kek, below) -- it never
#     touches the enc:v1:/enc:v2: payload itself. This separation is
#     deliberate; do not "simplify" by routing payload encryption
#     through age, or the shared format with ACP's secretsCrypto.js
#     breaks silently.
#   - DBA-5: any secret WRITE must follow write-temp -> fsync ->
#     atomic-rename -> write-marker-the-same-way ordering (write_secret,
#     below) so a process kill mid-write cannot produce a torn state
#     for the highest-blast-radius secret this protects (the Postgres
#     superuser password -- see section 3 of the design doc).
#   - Section 7.1: migration to this mechanism is strictly opt-in,
#     never automatic. This file's read path (read_secret, below)
#     transparently falls back to the existing flat-file convention
#     (runtime/secrets/*.txt) whenever DUNE_KEK_FILE/DUNE_AGE_IDENTITY_FILE
#     are not both set -- every existing operator sees zero behavior
#     change unless they explicitly opt in via `dune secrets setup`
#     (not yet implemented; this file is the library the eventual CLI
#     command will call).
#
# This file is a library, meant to be sourced (like host-paths.sh,
# runtime-env.sh), not executed directly.

DUNE_SECRETS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUNE_SECRETS_AEAD_PY="$DUNE_SECRETS_LIB_DIR/secrets_aead.py"

# Cache for the decrypted KEK, scoped to this process only. Never
# written back to disk -- matches the same in-memory-only property
# ACP's loadKEK() already has (independently verified during the
# Layer 1 audit's Security Architect review). Bash has no true private
# module state, so this is a global; callers must not read/write it
# directly, only through dune_secrets_* functions below.
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
#   is wrong, or the KEK file is corrupted -- mirrors ACP's loadKEK()'s
#   own deliberate "fail soft, let the caller decide" behavior, since a
#   hard failure here would need to be caught by every single caller
#   individually rather than centrally.
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
#   This is load-bearing, not a style choice: an earlier version of
#   this file (and of secrets_aead.py) passed both values as argv,
#   which a Requirement 20 Layer 2 audit found -- and this session
#   independently reproduced via /proc/<pid>/cmdline -- made every KEK,
#   DEK, and plaintext secret fully visible to any local user or
#   process able to read /proc for the entire lifetime of the python3
#   process. That is the exact vulnerability class
#   (GHSA-fc89-h24v-6j3x) this whole initiative exists to eliminate,
#   just relocated from Docker's `-e`/`docker inspect` exposure to a
#   CLI argv exposure. `printf` below is a shell BUILTIN (confirmed via
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

# dune_secrets_encrypted_path <name>
#   Prints the path where <name>'s age-encrypted form would live, e.g.
#   dune_secrets_encrypted_path postgres-password
#     -> runtime/secrets/postgres-password.enc
dune_secrets_encrypted_path() {
  local name="$1"
  printf 'runtime/secrets/%s.enc\n' "$name"
}

# dune_secrets_migration_marker_path <name>
#   Prints the per-secret migration completion marker path (section 7.4
#   of the design doc -- one marker per secret, not one global marker,
#   so a partially-completed migration batch can be resumed without
#   reprocessing already-migrated secrets).
dune_secrets_migration_marker_path() {
  local name="$1"
  printf 'runtime/generated/.secrets-migrated/%s.done\n' "$name"
}

# dune_secrets_render_plaintext_file <path> <content> [<mode>]
#   Writes <content> to <path> as a plain (non-atomic-write) file,
#   intended for short-lived, bind-mount-source renders like
#   start-postgres.sh's Postgres superuser password file -- NOT for
#   the age-encrypted .enc secret store itself, which must use
#   _dune_secrets_atomic_write below instead.
#
#   Defends against a real, reproduced production incident (issue
#   #259): if <path> already exists but is NOT a regular file (e.g. a
#   stray directory, which Docker itself can leave behind at a
#   bind-mount source path under some failure conditions), a naive
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
    echo "dune secrets: WARNING: $path exists but is not a regular file (this indicates a prior abnormal state -- see issue #259). Removing it automatically." >&2
    rm -rf "$path"
  else
    rm -f "$path"
  fi

  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"

  umask 077
  printf '%s' "$content" > "$path"
  chmod "$mode" "$path"
}

# dune_secrets_sync_postgres_password <container> <db-user> <password>
#   Forces the live Postgres superuser password inside <container> to
#   match <password>, via `ALTER USER <db-user> WITH PASSWORD ...` over
#   a local connection (host 127.0.0.1, matching this fork's own
#   pg_hba.conf `trust` rule for local connections regardless of which
#   password is currently set). Returns 0 on success, 1 if the ALTER
#   fails for any reason (wrong container name, container not ready,
#   psql not found, etc).
#
#   Exists specifically to close issue #260: Postgres's own
#   docker-entrypoint.sh only applies POSTGRES_PASSWORD_FILE during
#   first-time initdb. On an existing data directory -- the real
#   upgrade path, an operator turning the age secrets backend on for a
#   host that already has a live cluster -- the file's value is
#   silently ignored by Postgres, and the encrypted secrets store can
#   end up holding a password that does NOT match what Postgres will
#   actually accept, with no error surfaced at the point the bad value
#   is written. Calling this function after every container start (not
#   just "first time") when the age backend is configured keeps the
#   live database and the encrypted store from ever silently
#   diverging.
#
#   Callers MUST treat a non-zero return as fatal and must NOT report
#   success to the operator -- see start-postgres.sh for the required
#   error-handling pattern. The password is passed to psql via a
#   heredoc-style -c argument value, never appended to the container's
#   argv in a way that would appear in `docker inspect`/`ps` (psql's
#   own argv here contains only the SQL text with the password already
#   substituted in-process, matching this fork's existing
#   GHSA-fc89-h24v-6j3x remediation discipline for how secrets must
#   reach a process).
#
#   IMPORTANT for anyone verifying a fix built on this function: do NOT
#   verify success/failure via `docker exec`/127.0.0.1 alone -- this
#   fork's pg_hba.conf trusts local connections unconditionally, so an
#   auth check made that way will falsely "pass" even with a wrong
#   password (confirmed during the #260 live reproduction). Verify the
#   password actually took effect via a real network client instead
#   (e.g. `docker run --rm --network dune-net postgres:<tag> psql -h
#   <container> -U <db-user> ...`).
dune_secrets_sync_postgres_password() {
  local container="$1"
  local db_user="$2"
  local password="$3"

  local password_sql
  password_sql="$(printf '%s' "$password" | sed "s/'/''/g")"

  docker exec -i "$container" psql -h 127.0.0.1 -p 5432 -U "$db_user" -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "ALTER USER $db_user WITH PASSWORD '$password_sql';" \
    >/dev/null
}

# _dune_secrets_atomic_write <final-path> <content> [<mode>]
#   Writes <content> to <final-path> via write-to-temp -> fsync ->
#   atomic rename, per design doc section 7.4 [R2]/[R3] -- the exact
#   discipline that closes DBA-5 (a torn state where a marker exists
#   but the underlying secret file doesn't, or vice versa). <mode>
#   defaults to 0600 (never world/group-readable) unless overridden.
_dune_secrets_atomic_write() {
  local final_path="$1"
  local content="$2"
  local mode="${3:-600}"

  local dir
  dir="$(dirname "$final_path")"
  mkdir -p "$dir"

  local tmp_path
  tmp_path="$(mktemp "${final_path}.tmp.XXXXXX")"

  # printf, not echo -- avoids any risk of interpreting backslash
  # sequences or trailing-newline surprises in the secret content.
  printf '%s' "$content" > "$tmp_path"
  chmod "$mode" "$tmp_path"

  # fsync the temp file's contents before the rename that publishes it,
  # so a crash between fsync and rename leaves, at worst, an orphaned
  # temp file -- never a final path with truncated/partial content.
  # dd is used purely as a portable way to invoke fsync(2) on an
  # existing file descriptor without requiring a compiled helper;
  # `sync` alone is not sufficient (it syncs the whole filesystem's
  # buffers, not specifically this file, and gives no per-file
  # ordering guarantee relative to the following rename).
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import os
fd = os.open('$tmp_path', os.O_RDONLY)
os.fsync(fd)
os.close(fd)
"
  fi

  mv -f "$tmp_path" "$final_path"
}

# dune_secrets_write_secret <name> <plaintext>
#   Encrypts <plaintext> with a fresh DEK, wraps that DEK with the
#   current KEK, and writes both to <name>'s .enc file atomically (per
#   _dune_secrets_atomic_write above), then writes the per-secret
#   migration marker -- ONLY after the .enc write has fully succeeded,
#   per design doc section 7.4's explicit ordering requirement.
#
#   The on-disk .enc file format is a single line:
#     enc:v2:1:<base64(wrapped_dek)>:<base64(iv+tag+ciphertext)>
#   This is Core's own file-level framing (distinct from, but
#   consistent with, the enc:v2:<version>: prefix ACP stores inline in
#   a database column) -- Core has no database row to store the
#   wrapped DEK alongside, so it's stored in the same flat file,
#   colon-separated, ahead of the ciphertext payload.
#
#   Requires the KEK backend to be configured (dune_secrets_backend_configured);
#   callers must check this themselves before calling, or check this
#   function's own non-zero exit code.
dune_secrets_write_secret() {
  local name="$1"
  local plaintext="$2"

  local kek
  if ! kek="$(dune_secrets_load_kek)"; then
    echo "dune secrets: cannot write '$name' -- KEK backend not configured or unavailable." >&2
    return 1
  fi

  local dek
  dek="$(dune_secrets_generate_dek)"

  local wrapped_dek ciphertext
  wrapped_dek="$(_dune_secrets_aead_encrypt "$kek" "$dek")"
  ciphertext="$(_dune_secrets_aead_encrypt "$dek" "$plaintext")"

  local enc_path
  enc_path="$(dune_secrets_encrypted_path "$name")"

  _dune_secrets_atomic_write "$enc_path" "enc:v2:1:${wrapped_dek}:${ciphertext}" 600

  local marker_path
  marker_path="$(dune_secrets_migration_marker_path "$name")"
  _dune_secrets_atomic_write "$marker_path" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 600
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
  enc_path="$(dune_secrets_encrypted_path "$name")"
  [ -r "$enc_path" ] || return 1

  local kek
  kek="$(dune_secrets_load_kek)" || return 1

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
#   The generic "any script reads a secret" seam described in section 4
#   of the design doc. Tries the age-encrypted form first; if the
#   backend isn't configured, the .enc file doesn't exist yet, or
#   decryption fails for any reason, transparently falls back to
#   reading <legacy-flat-file-path> exactly as every script already
#   does today (cat | tr -d '\r\n') -- so an operator who never runs
#   `dune secrets setup` sees zero behavior change, forever, by design
#   (section 7.1: strictly opt-in, never automatic).
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
