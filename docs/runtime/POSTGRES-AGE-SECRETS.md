# Age-Based Secrets for the Postgres Superuser Password

**Status:** Implemented, opt-in, shipped in PR #257 (issue #128).
**Affects:** the Postgres superuser (`postgres` role) credential only. The `dune` role's
application password and every other secret in `runtime/secrets/` are unaffected by this
document.

## Why this exists

Before this feature, `start-postgres.sh` launched the `dune-postgres` container with:

```
-e POSTGRES_PASSWORD=postgres
```

Any process with Docker socket access could read this value in full via
`docker inspect dune-postgres --format '{{.Config.Env}}'` — a real, confirmed exposure
(GHSA-fc89-h24v-6j3x). This feature replaces that literal, hardcoded value with a real
random password, encrypted at rest using [age](https://github.com/FiloSottile/age) envelope
encryption, and delivered to the container via `POSTGRES_PASSWORD_FILE` instead of a plain
environment variable.

**This is strictly opt-in.** If you have never done anything described in this document,
nothing about your deployment changes. The superuser password remains the literal string
`postgres`, exactly as before, and your server behaves identically to every prior release
(Requirement 0 — zero behavior change for operators who don't opt in).

## Is there a `dune secrets setup` command?

**Not yet.** As of this writing, enabling this feature is a manual, one-time process
(described below). A dedicated CLI command that automates this (`dune secrets setup`) is a
separate, not-yet-implemented deliverable — see the design doc referenced at the bottom of
this file. Do not expect this command to exist; follow the manual steps below instead.

---

## Prerequisites

You need the `age` and `age-keygen` binaries installed on the host running `dune-postgres`.

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y age

# Confirm both binaries are present
command -v age && command -v age-keygen
```

You also need `python3` with the `cryptography` package installed (used internally by
`secrets_aead.py` for the actual AES-256-GCM encryption — `age` itself is only used to
protect the wrapping key, not your secret values directly):

```bash
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" \
  || pip install --user cryptography
```

---

## Enabling this feature (fresh install or existing install — same procedure)

This procedure is identical whether you're setting up a brand-new server or turning this on
for a server that has been running for months with real player data. That equivalence is not
an accident — issue #260 (see "What can go wrong" below) was exactly a bug where enabling
this on an *existing* install silently broke in a way a fresh install never would have
revealed. The fix makes both cases behave the same way; you do not need to do anything
different for an existing install.

### Step 1 — Generate an age identity

This is your **root of trust**. Anyone who has this file can decrypt your Postgres superuser
password. Treat it like an SSH private key.

```bash
cd ~/projects/dune/dune-awakening-selfhost-docker   # your repo root
mkdir -p runtime/generated/.dune-age
age-keygen -o runtime/generated/.dune-age/identity.txt
chmod 600 runtime/generated/.dune-age/identity.txt
```

This prints a public key to stdout, e.g. `age1cv9u3ffpk6k7e6vd3m5djceqtvxrrjlyvqsf3k2dngg5a2hxccqscgumvh`.
Save that value — you'll need it in the next step. It is not secret (it's a *public* key);
you don't need to protect it the way you protect the identity file.

**Before continuing, read the "Break-Glass Recovery" section below and decide now how you
will back up this identity file.** There is no password-reset mechanism for a lost age
identity — losing this file means permanently losing the ability to decrypt your stored
Postgres superuser password via this mechanism (see "What if I lose the identity file?"
below for what your actual recovery options are in that case).

### Step 2 — Generate and encrypt a KEK (Key-Encryption-Key)

```bash
source runtime/scripts/lib/secrets.sh
PUBKEY="age1..."   # the public key age-keygen printed in Step 1
KEK_HEX="$(dune_secrets_generate_dek)"
printf '%s' "$KEK_HEX" | age --encrypt -r "$PUBKEY" -o runtime/generated/.dune-age/kek.age
chmod 600 runtime/generated/.dune-age/kek.age
unset KEK_HEX   # don't leave this in your shell history/environment longer than necessary
```

### Step 3 — Point the environment at your identity and KEK

Add these two lines to your `.env` file (or export them in whatever mechanism starts
`start-postgres.sh` for you — a systemd unit's `Environment=` directives, etc.):

```bash
DUNE_KEK_FILE=/absolute/path/to/runtime/generated/.dune-age/kek.age
DUNE_AGE_IDENTITY_FILE=/absolute/path/to/runtime/generated/.dune-age/identity.txt
```

Use **absolute paths**. `start-postgres.sh` may be invoked from different working
directories depending on how you run it (directly, via `dune restart`, via a systemd timer),
and a relative path is not guaranteed to resolve the same way in all of them.

### Step 4 — Restart Postgres

```bash
bash runtime/scripts/start-postgres.sh
```

On this first run with the backend configured, the script will:
1. Generate a new random 64-character superuser password.
2. Encrypt and store it at `runtime/secrets/postgres-superuser-password.enc`.
3. Start (or restart) the `dune-postgres` container with `POSTGRES_PASSWORD_FILE` pointing at
   a short-lived rendered copy of that password.
4. **Explicitly force the live database's password to match** via `ALTER USER` over a local,
   trusted connection — this step exists specifically because Postgres's own startup process
   does *not* reliably apply the password on an already-existing data directory (see "What
   can go wrong" below). If this step fails, the script exits with a clear, non-zero error —
   it will never silently report success while leaving the live password out of sync with
   what's stored.

### Step 5 — Verify

**Do not verify using `docker exec`, `psql -h 127.0.0.1`, or anything connecting to
`localhost`/`127.0.0.1`.** This fork's Postgres image trusts local connections
unconditionally (`pg_hba.conf`'s `trust` rule) — a check made this way will report success
even with a completely wrong password, and you will not have actually verified anything.

Verify over the real container network instead:

```bash
source runtime/scripts/lib/secrets.sh
export DUNE_KEK_FILE=/absolute/path/to/runtime/generated/.dune-age/kek.age
export DUNE_AGE_IDENTITY_FILE=/absolute/path/to/runtime/generated/.dune-age/identity.txt
NEW_PASS="$(dune_secrets_read_encrypted "postgres-superuser-password")"

docker run --rm --network dune-net -e PGPASSWORD="$NEW_PASS" postgres:17 \
  psql -h dune-postgres -U postgres -c "SELECT 'it works' AS result;"
```

You should see a single row containing `it works`. If instead you get a password
authentication error, do not assume your server is broken — re-run
`bash runtime/scripts/start-postgres.sh` once (a transient failure is the most common cause),
then see "Break-Glass Recovery" if it persists.

---

## What can go wrong (and what's already been fixed)

This feature went through three real, live-reproduced incidents during development. All
three are fixed as of the current version, but understanding them helps you recognize
symptoms if you ever see something similar:

- **Issue #258**: an early version deleted the password's render file immediately after
  starting the container, which corrupted Docker's own backup/`docker cp` mechanism for the
  *entire* container, not just this feature. If `dune db backup` or `docker cp` against
  `dune-postgres` ever fails with an error like `mkdirat ...: file exists`, that is this exact
  bug — you are not running the fixed version, and should update.
- **Issue #259**: the fix for #258 introduced a second bug — a leftover directory (instead of
  a file) at the render path could abort the startup script entirely, leaving `dune-postgres`
  down. If `start-postgres.sh` ever fails immediately with no Postgres output at all, check
  `ls -la runtime/generated/.pg-superuser-password-runtime` — if it's a directory, you're on
  an unfixed version.
- **Issue #260**: enabling this feature on a host with an *already-initialized* Postgres data
  directory (i.e. any real, existing deployment — not a brand-new install) silently generated
  a password that Postgres's own startup process never actually adopted, because Postgres
  only applies `POSTGRES_PASSWORD_FILE` during first-time database initialization. The fix
  (the "ALTER USER" step described in Step 4 above) explicitly forces the live database to
  match whatever is stored, on every single startup, not just the first one.

If you are running a version from before all three of these were fixed, update before
enabling this feature.

---

## Break-Glass Recovery

### If `runtime/secrets/postgres-superuser-password.enc` becomes corrupted or unreadable

As of the current version, `start-postgres.sh` will **refuse to start** with a clear error
rather than silently generating a replacement password (which would discard whatever was
actually in use). To recover:

1. Confirm your `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` paths in `.env` are correct and the
   files exist and are readable.
2. If those are correct and the `.enc` file itself is genuinely corrupted, you cannot recover
   the *specific* password that was stored — but you do not need to, because of the mechanism
   in the next section.

### If you need to regain access regardless of what's stored (true break-glass)

Because this fork's `pg_hba.conf` trusts local connections unconditionally, **you always have
a way back in, independent of the age/KEK mechanism entirely**:

```bash
docker exec -i dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD 'a-new-password-you-choose';"
```

This works regardless of what is or isn't stored in the encrypted secrets store, as long as
the `dune-postgres` container itself is running. This is the actual, load-bearing break-glass
mechanism for this feature — not a theoretical one. After running this, re-encrypt and store
the new value so future restarts don't fight it:

```bash
source runtime/scripts/lib/secrets.sh
export DUNE_KEK_FILE=/absolute/path/to/kek.age
export DUNE_AGE_IDENTITY_FILE=/absolute/path/to/identity.txt
rm -f runtime/secrets/postgres-superuser-password.enc
dune_secrets_write_secret "postgres-superuser-password" "a-new-password-you-choose"
```

### If you lose the age identity file entirely

**There is no password-reset mechanism for a lost age identity — this is by design, the same
way there's no "reset" for a lost SSH private key or a lost disk-encryption key.** If
`runtime/generated/.dune-age/identity.txt` (or wherever you stored it) is gone, you cannot
decrypt the KEK, and therefore cannot decrypt `postgres-superuser-password.enc` via this
mechanism, ever.

**This does not mean your server is unrecoverable.** Because of the local-trust break-glass
mechanism above, you can always regain database access as long as the container is running,
by setting a brand-new password directly. Your recovery path is:

1. Use the `docker exec ... ALTER USER ...` command above to set a fresh password you control.
2. Generate a brand-new age identity and KEK (Step 1-2 of the install procedure above).
3. Point `.env` at the new files.
4. Re-encrypt the new password you just set with `dune_secrets_write_secret`, exactly as
   shown in the previous section.
5. Restart Postgres and re-verify per Step 5 above.

You lose nothing except the ability to decrypt whatever the *old*, now-inaccessible password
was — which doesn't matter, since you're replacing it anyway. Your actual database (roles,
schemas, game data) is never at risk from losing this identity file; only the *credential*
protecting access to it is affected, and that credential is always resettable via the
local-trust mechanism as long as the container itself is up.

**Recommended, before you ever need this:** back up `identity.txt` somewhere durable and
offline — a password manager, an encrypted USB drive kept physically separate from this host,
or printed/QR-coded and stored in a safe. Treat it exactly like a private key, because that's
what it is. A dedicated QR-code/Shamir-secret-sharing break-glass tool is planned but not yet
implemented (see the design doc below) — until it exists, a manual, offline backup of the raw
identity file is your only durable protection against permanent loss.

### If you disabled this feature after enabling it, and things seem inconsistent

**Known gap, tracked separately (issue #261), not yet fixed**: unsetting
`DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` after having enabled this feature does **not** revert
the live database's password back to the hardcoded default. The live password stays whatever
it was last set to by this mechanism — Postgres, again, does not re-apply
`POSTGRES_PASSWORD_FILE` on an existing data directory. If you disable this feature and are
confused about what the current password actually is, use the `docker exec ... ALTER USER
...` break-glass command above to set a known value explicitly, rather than assuming a
disable reverted anything.

---

## Where things are stored

| Item | Path | Contents | Back up? |
|---|---|---|---|
| Age identity | wherever you chose (recommend `runtime/generated/.dune-age/identity.txt`) | Your root-of-trust private key | **Yes — offline, durably, before you need it** |
| Encrypted KEK | wherever you chose (recommend `runtime/generated/.dune-age/kek.age`) | The wrapping key, itself encrypted with your identity | Optional — can be regenerated from a new identity if needed, but backing it up alongside the identity avoids that step |
| Encrypted password | `runtime/secrets/postgres-superuser-password.enc` | The actual superuser password, encrypted | Not required — regenerable via the break-glass procedure above |
| Short-lived render file | `runtime/generated/.pg-superuser-password-runtime` | Plaintext password, mode 600, bind-mounted into the container | Never — this is regenerated on every startup and is not meant to persist |

None of these paths are included in `dune db backup` (which only backs up the Postgres
database contents itself), and all of them are git-ignored (`runtime/secrets/`,
`runtime/generated/` are both already excluded — confirmed, not assumed, via
`git check-ignore -v` during this feature's own audit).

---

## Further reading

- Design document: `~/projects/meta/Arrakis-Project/docs/design/unified-age-secrets-management-l1-design-2026-08-13.md`
  (the full architecture, including the reasoning for choosing age over Vault/Infisical/other
  alternatives, and the eventual `dune secrets setup` CLI design).
- Layer 3 audit findings register: `docs/security/pr-257-layer3-integration-audit-2026-08-13.md`
  (what was independently reviewed and fixed before this feature shipped).
- Issue #128 (umbrella tracking issue), #258, #259, #260, #261 on this repository's GitHub
  Issues for the full incident history behind the "What can go wrong" section above.
