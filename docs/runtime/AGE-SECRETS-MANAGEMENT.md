# Age-Based Secrets Management

**Status:** Implemented, opt-in.
**Affects:** six secrets today — the Postgres superuser (`postgres` role) password, the
Funcom service token, the RabbitMQ HTTP token-auth secret, the FLS API key, and the two
server-login secrets (`server-login-password-secret` / `username-server-login-secret`).
Every other secret in `runtime/secrets/` (the admin web password/session secret, the Discord
adapter token, the public directory file) is unaffected by this document — see "What is
NOT covered by this document" near the end for exactly why, secret by secret.

## Why this exists

Before this feature, `start-postgres.sh` launched the `dune-postgres` container with:

```
-e POSTGRES_PASSWORD=postgres
```

Any process with Docker socket access could read this value in full via
`docker inspect dune-postgres --format '{{.Config.Env}}'` — a real, confirmed exposure
(GHSA-fc89-h24v-6j3x). This feature replaces that literal, hardcoded value — and, as of this
revision, five other secrets that were previously read as plain flat files scattered across
more than a dozen scripts — with a shared, general-purpose secrets library
(`runtime/scripts/lib/secrets.sh`) backed by [age](https://github.com/FiloSottile/age)
envelope encryption. This is a genuine secrets *manager*, not a Postgres-specific patch: the
Postgres password was simply the first, highest-priority consumer to be wired up.

**This is strictly opt-in, for every secret it covers.** If you have never done anything
described in this document, nothing about your deployment changes. Every secret listed above
continues to be read from its existing plain flat file in `runtime/secrets/`, exactly as
before, and your server behaves identically to every prior release.

## Is there a `dune secrets setup` command?

**Not yet.** As of this writing, enabling this feature is a manual, one-time process
(described below), and it is opt-in **per secret** — you do not have to migrate all six at
once. A dedicated CLI command that automates this is a natural follow-on but is not part of
this change.

---

## If your server is down and you're reading this in a panic, read this first

You will always be able to get back in, as long as the `dune-postgres` container is running,
regardless of anything else in this document. There is exactly **one command** you need:

```bash
source runtime/scripts/lib/secrets.sh
dune_secrets_sync_postgres_password "dune-postgres" "postgres" "a-new-password-you-choose"
```

That's it. Full explanation, what to do next, and every other recovery scenario (lost
identity file, corrupted secret store, etc.) is in **Break-Glass Recovery** below — read it
in full once things are calm again, but the command above is all you need right now.

**Do not run `docker exec ... psql -c "ALTER USER ..."` by hand.** That has the same security
problem this whole feature exists to fix (see the warning in Break-Glass Recovery below for
why). Always use the `dune_secrets_sync_postgres_password` function shown above instead — it
does the same thing safely.

**None of the other five secrets covered by this document have (or need) an equivalent
emergency mechanism.** If any of them (the Funcom token, the RMQ secret, the FLS API key, or
either server-login secret) is ever wrong or missing, the affected script fails loudly with a
clear error at startup — there is no live "unlock" needed, because these secrets don't gate
access to a running database the way the Postgres password does. See "What can go wrong" for
each secret's specific failure mode.

---

## Break-Glass Recovery (Postgres superuser password only)

Everything in this section is specific to the Postgres superuser password. The other five
secrets this document covers do not have a break-glass mechanism because they don't need
one — see the note above.

### The one command (repeated from above, with full context)

```bash
source runtime/scripts/lib/secrets.sh
dune_secrets_sync_postgres_password "dune-postgres" "postgres" "a-new-password-you-choose"
```

Because this image's `pg_hba.conf` trusts local connections unconditionally, **this always
works, regardless of what is or isn't stored in the encrypted secrets store, as long as the
`dune-postgres` container itself is running** — it does not depend on the age/KEK mechanism
being intact at all. This is the actual, load-bearing break-glass mechanism for this
feature, not a theoretical one.

**Why not just run `psql -c "ALTER USER ..."` directly?** Because that puts the plaintext
password into that process's own argv, visible via `/proc/<pid>/cmdline` (or `ps aux`) to
any other local process for as long as it runs — the exact same class of exposure
(GHSA-fc89-h24v-6j3x) this entire feature eliminates from `docker inspect`.
`dune_secrets_sync_postgres_password` instead pipes the password over stdin, matching how
`start-postgres.sh` does this internally, and avoids reintroducing that exposure at the exact
moment — an emergency — where you're least likely to be thinking about it.

After running the command above, re-encrypt and store the new value so future restarts don't
fight it:

```bash
source runtime/scripts/lib/secrets.sh
export DUNE_KEK_FILE=/absolute/path/to/kek.age
export DUNE_AGE_IDENTITY_FILE=/absolute/path/to/identity.txt
rm -f runtime/secrets/postgres-superuser-password.enc
dune_secrets_write_secret "postgres-superuser-password" "a-new-password-you-choose"
```

**A note on shell history**: both commands above put the plaintext password into a command
you type or paste into an interactive shell. Unless your shell is configured otherwise
(`HISTCONTROL=ignorespace` is **not** the default), that command is saved in plaintext in
`~/.bash_history` (or equivalent) the moment you run it. If this matters for your threat
model, either run these commands from a script file (not pasted into an interactive prompt)
and delete the script afterward, or explicitly clear the relevant history entries
(`history -d <line>`) once done.

### If `runtime/secrets/postgres-superuser-password.enc` becomes corrupted or unreadable

`start-postgres.sh` will **refuse to start** with a clear error rather than silently
generating a replacement password (which would discard whatever was actually in use). To
recover:

1. Confirm your `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` paths in `.env` are correct and the
   files exist and are readable.
2. If those are correct and the `.enc` file itself is genuinely corrupted, you cannot recover
   the *specific* password that was stored — but you do not need to, because of the "one
   command" mechanism above.

### If you lose the age identity file entirely

**There is no password-reset mechanism for a lost age identity — this is by design, the same
way there's no "reset" for a lost SSH private key or a lost disk-encryption key.** If your
identity file is gone, you cannot decrypt the KEK, and therefore cannot decrypt any secret
protected by it — not just `postgres-superuser-password.enc`, but every other secret you've
migrated to this mechanism, ever.

**This does not mean your server is unrecoverable.** For the Postgres password specifically,
because of the local-trust break-glass mechanism above, you can always regain database access
as long as the container is running, by setting a brand-new password directly. Your recovery
path is:

1. Use the "one command" above to set a fresh Postgres password you control.
2. Generate a brand-new age identity and KEK (Steps 1-2 of "Enabling this feature" below).
3. Point `.env` at the new files.
4. Re-encrypt the Postgres password you just set with `dune_secrets_write_secret`, exactly as
   shown above.
5. **For every other secret you had migrated** (Funcom token, RMQ secret, FLS API key, either
   server-login secret): the plaintext flat file in `runtime/secrets/` is **never deleted**
   by this mechanism (see "The exact fallback and precedence rule" below) — so as long as you
   haven't manually deleted those flat files, they are still there, readable, and will be
   used automatically the moment the new age identity/KEK can't decrypt the old encrypted
   forms. Re-migrate each one with the new identity if you want them encrypted again:
   `dune_secrets_write_secret "<name>" "$(cat runtime/secrets/<name>.txt)"` for each.
6. Restart Postgres and re-verify per Step 5 of "Enabling this feature" below. Restart any
   game-server component you migrated the other five secrets for, and confirm via
   `docker inspect <container> --format '{{.Config.Env}}'` that the expected values are still
   being delivered (see "How to verify a migration" for each secret, below).

You lose nothing except the ability to decrypt whatever the *old* encrypted values were —
which doesn't matter for Postgres, since you're replacing that password anyway, and doesn't
matter for the other five secrets either, since their plaintext flat-file originals are still
on disk and were never touched. Your actual database (roles, schemas, game data) is never at
risk from losing this identity file; only the *credential material this specific mechanism
protects* is affected, and every one of those credentials is either directly resettable
(Postgres, via local-trust) or already recoverable from its still-present flat file (the
other five).

**Recommended, before you ever need this**: back up your identity file somewhere durable and
offline, *before* you finish setup below, not after. Concretely, as an actual first step (not
just an abstract recommendation): copy the file to a password manager entry (most support
arbitrary file/note attachments), or to an encrypted USB drive kept physically separate from
this host. This file is small (~200 bytes) — there is no reason to defer this. **Test your
backup by actually restoring from it once** — an unverified backup of a
permanently-unrecoverable credential is not a real safety net.

### If you disable the Postgres migration after enabling it, and things seem inconsistent

**Known limitation, Postgres-specific**: unsetting `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE`
after having enabled this feature does **not** revert the live database's password back to
the hardcoded default. The live password stays whatever it was last set to by this mechanism
— Postgres, again, does not re-apply `POSTGRES_PASSWORD_FILE` on an existing data directory.
If you disable this feature and are confused about what the current password actually is, use
the "one command" above to set a known value explicitly, rather than assuming a disable
reverted anything.

**This specific limitation does NOT apply to the other five secrets.** Unsetting
`DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` for the Funcom token, RMQ secret, FLS API key, or
either server-login secret simply and immediately reverts every consuming script back to
reading the plain flat file — because, unlike Postgres, none of these secrets are held inside
a running process that has to be told about the change; they're re-read fresh from disk on
every single container start. See "The exact fallback and precedence rule" below for exactly
why this asymmetry exists.

---

## Prerequisites

You need the `age` and `age-keygen` binaries installed on the host.

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

## The exact fallback and precedence rule (read this before migrating anything)

Every secret this document covers is read through one shared function,
`dune_secrets_read_secret <name> <legacy-flat-file-path>` (in `runtime/scripts/lib/secrets.sh`),
via a small set of named resolver functions in `runtime/scripts/runtime-env.sh`
(`resolve_funcom_token`, `resolve_rmq_http_token_auth_secret`, `resolve_fls_apikey`,
`resolve_server_login_password_secret`, `resolve_username_server_login_secret`) plus one
dedicated function for Postgres specifically (`dune_secrets_sync_postgres_password`, which
works differently — see the Postgres section above).

For the five secrets that go through `dune_secrets_read_secret`, the rule is:

1. **If the age backend is configured** (`DUNE_KEK_FILE` and `DUNE_AGE_IDENTITY_FILE` are
   both set) **and** an encrypted form of this specific secret already exists
   (`runtime/secrets/<name>.enc`) — read and use the encrypted value. The plain flat file is
   never consulted, never re-read, and never overwritten in this case.
2. **Otherwise** — read the plain flat file exactly as every script already did before this
   feature existed (`tr -d '\r\n' < runtime/secrets/<name>.txt`).
3. **If the flat file doesn't exist either**, and this secret is one that auto-generates
   (the RMQ secret and the FLS API key — see the per-secret sections below for exactly which
   ones and why), a fresh random value is generated and written to the flat file, exactly
   matching what every affected script already did before this feature existed.
4. **If the flat file doesn't exist and this secret does NOT auto-generate** (the Funcom
   token, and both server-login secrets), the resolver fails — the consuming script gets a
   clear error, not a silently-empty value.

**Critically: migrating a secret to the encrypted form never deletes, modifies, or
regenerates the existing flat file.** This is true in every case, including the
auto-generating ones — verified directly, live, during development (see "Evidence" in each
per-secret section below). This is what makes rollback trivial: to stop using the encrypted
form for any one secret, delete or move its `.enc` file (`runtime/secrets/<name>.enc`), or
simply unset `DUNE_KEK_FILE`/`DUNE_AGE_IDENTITY_FILE` entirely to revert *all five* at once —
either way, the untouched flat file is read on the very next restart, with zero data loss and
zero manual re-entry of the secret's value.

---

## Enabling this feature — general procedure (applies to every secret below)

This procedure is identical whether you're setting up a brand-new server or turning this on
for a server that has been running for months with real player data. **This equivalence is
not an assumption — it is the single most heavily verified claim in this entire document.**
See "Upgrade-Path Verification Evidence" near the end for the complete, secret-by-secret
record of exactly how this was confirmed, including one real (and unrelated) incident
encountered and fully resolved during that verification.

### Step 1 — Generate an age identity

This is your **root of trust** for every secret you migrate to this mechanism. Anyone who has
this file can decrypt every one of them. Treat it like an SSH private key.

```bash
cd /path/to/dune-awakening-selfhost-docker   # your repo root
mkdir -p runtime/generated/.dune-age
age-keygen -o runtime/generated/.dune-age/identity.txt
chmod 600 runtime/generated/.dune-age/identity.txt
```

This prints a public key to stdout, e.g. `age1cv9u3ffpk6k7e6vd3m5djceqtvxrrjlyvqsf3k2dngg5a2hxccqscgumvh`.
Save that value — you'll need it in the next step. It is not secret (it's a *public* key);
you don't need to protect it the way you protect the identity file.

**If you have not already read "Break-Glass Recovery" above, do so now, before continuing,
and back up this identity file before you move on to Step 2.** There is no password-reset
mechanism for a lost age identity.

### Step 2 — Generate and encrypt a KEK (Key-Encryption-Key)

One KEK protects every secret you migrate — you do not generate a separate KEK per secret.

```bash
source runtime/scripts/lib/secrets.sh
PUBKEY="age1..."   # the public key age-keygen printed in Step 1
KEK_HEX="$(dune_secrets_generate_dek)"
(umask 077; printf '%s' "$KEK_HEX" | age --encrypt -r "$PUBKEY" -o runtime/generated/.dune-age/kek.age)
chmod 600 runtime/generated/.dune-age/kek.age  # belt-and-suspenders; umask above already prevents a loose-permission window
unset KEK_HEX
```

Applies the same shell-history caveat noted in Break-Glass Recovery above.

### Step 3 — Point the environment at your identity and KEK

Add these two lines to your `.env` file (or export them in whatever mechanism starts the
relevant scripts for you — a systemd unit's `Environment=` directives, etc.):

```bash
DUNE_KEK_FILE=/absolute/path/to/runtime/generated/.dune-age/kek.age
DUNE_AGE_IDENTITY_FILE=/absolute/path/to/runtime/generated/.dune-age/identity.txt
```

Use **absolute paths**. These scripts may be invoked from different working directories
depending on how you run them, and a relative path is not guaranteed to resolve the same way
in all of them.

**Setting these two variables alone does not migrate anything.** It only makes the age
backend *available*. Each secret below is migrated individually, one at a time, in whatever
order you choose — see each secret's own subsection.

---

## Migrating each secret

### Postgres superuser password

Covered in full detail above and in "Break-Glass Recovery" — this is the one secret with its
own dedicated sync mechanism, its own break-glass procedure, and its own known limitation on
disable. Short version, once Steps 1-3 above are done:

```bash
bash runtime/scripts/start-postgres.sh
```

On first run with the backend configured, this generates a new random 64-character password,
encrypts and stores it, and explicitly forces the live database to match it via
`ALTER USER ... WITH PASSWORD ...` over a locally-trusted connection — this last step is what
makes the upgrade path safe (see "The real upgrade-path bug" below for exactly why it's
necessary). Verify **only** over a real network client, never `docker exec`/localhost — see
the full Postgres walkthrough above for the exact verification command and why the localhost
check gives a false pass.

### Funcom token, RMQ HTTP token-auth secret, FLS API key

These three are consumed by the game-server startup scripts
(`spawn-server.sh`, `start-director.sh`, `start-server-gateway.sh`, `start-server-overmap.sh`,
`start-server-survival-1.sh`, `start-text-router.sh`) and, for the Funcom token specifically,
also by `admin-tools.sh` (an existence check only), `db.sh` (a battlegroup-mismatch
diagnostic), `doctor.sh` (health-check display), and `battlegroup-identity.sh` (extracts the
`HostId` from the token to validate your Battlegroup ID).

To migrate any one of them:

```bash
source runtime/scripts/lib/secrets.sh
export DUNE_KEK_FILE=/absolute/path/to/runtime/generated/.dune-age/kek.age
export DUNE_AGE_IDENTITY_FILE=/absolute/path/to/runtime/generated/.dune-age/identity.txt

# Funcom token (replace <name> and the source file for the other two):
dune_secrets_write_secret "funcom-token" "$(cat runtime/secrets/funcom-token.txt)"
```

The three secret names to use in place of `funcom-token` above are exactly:
`funcom-token`, `rmq-http-token-auth-secret`, `fls-apikey`.

**You do not need to restart anything for the write itself to succeed** — but the new,
encrypted value only takes effect the next time each consuming script actually runs.
Game-server containers read these values once, at container start, and hold them for their
entire lifetime (they are delivered via `docker run -e ...`, not re-read while running) — so
migrating the underlying secret does not, by itself, change anything about an already-running
container. You must restart the relevant container(s) for the new value to actually be used.

**How to verify a migration took effect**: restart the affected script (e.g.
`bash runtime/scripts/start-text-router.sh`), then compare:

```bash
docker inspect <container-name> --format '{{.Config.Env}}' | tr ' ' '\n' | grep -i "funcom\|rmq\|fls-apikey\|gateway_farm_api_key"
```

against the actual value you expect (the same value you migrated in, decrypted via
`dune_secrets_read_secret "<name>" runtime/secrets/<name>.txt`). They must match exactly.

**Note on `funcom_token_host_id()`**: if you use `battlegroup-identity.sh` (called
automatically by `doctor.sh`, `start-all.sh`, and others), this function extracts the
`HostId` field from the Funcom token's JWT payload to validate your Battlegroup ID. It works
identically whether the token comes from the plain flat file or the encrypted store — the
token *value* is what's passed in, piped to a small Python helper via stdin, never via argv
or an environment variable (confirmed live via `strace -f -e trace=execve` inspection during
development — see "Security note" below for why this specific detail matters).

### Server login secrets

`server-login-password-secret` and `username-server-login-secret` are both auto-generated
(32 random bytes, hex-encoded) the first time any script that needs them runs, if their flat
file doesn't already exist — this was true before this feature existed and remains true
after. They are consumed by every game-server startup script listed above.

Migration procedure is identical to the three secrets above:

```bash
dune_secrets_write_secret "server-login-password-secret" "$(cat runtime/secrets/server-login-password-secret.txt)"
dune_secrets_write_secret "username-server-login-secret" "$(cat runtime/secrets/username-server-login-secret.txt)"
```

---

## What can go wrong

### The real upgrade-path bug (Postgres-specific)

Postgres's own `docker-entrypoint.sh` only applies `POSTGRES_PASSWORD_FILE` during
**first-time** `initdb`. Enabling this feature on a host with an **already-initialized**
Postgres data directory (i.e. any real, existing deployment — not a brand-new install)
silently generated a password that Postgres's own startup process never actually adopted.
This left the encrypted secrets store holding a password that didn't match what the live
database would actually accept, with no error at the point the bad value was written. The
fix (the `ALTER USER` step) explicitly forces the live database to match whatever is stored,
on every single startup, not just the first one — which is what makes the "same procedure for
fresh installs and existing installs" claim actually true for Postgres, rather than
aspirational.

Reproducing this correctly required discovering a real verification pitfall: this image's
`pg_hba.conf` grants unconditional `trust` for local (`127.0.0.1`/`::1`/`local`) connections,
so verifying via `docker exec`/localhost gives a false "success" for *any* password, correct
or not. The actual reproduction required a real client on the container's Docker network.

**This specific bug class does not apply to the other five secrets**, and this is worth
explaining precisely, not just asserting: the Postgres bug exists because Postgres's own
startup code makes an internal decision ("apply this password, or don't") based on data-
directory state that this project's scripts have no visibility into or control over. The other
five secrets have no equivalent internal state — they are plain values, delivered fresh via
`docker run -e` on every single container start, with no analogous "already initialized,
ignore this new value" logic anywhere in the consuming game-server binary or its startup
scripts. There is structurally no way for the encrypted store and the live, running process
to silently diverge for these five, the way there was for Postgres — confirmed by the
Upgrade-Path Verification Evidence below, not merely inferred from this architectural
argument.

### Two earlier bugs in the Postgres implementation itself, fixed before this feature shipped

- **Deleting the password's render file too early**: an early implementation deleted the
  render file immediately after starting the container, which corrupted Docker's own
  backup/`docker cp` mechanism for the *entire* container. Fixed: stale files are only
  cleaned up at the *start* of the next invocation, after the previous container has already
  been removed.
- **A too-eager cleanup fix that could itself abort startup**: the fix above introduced a
  second bug — a leftover directory (instead of a file) at the render path could make a naive
  `rm -f` exit non-zero, aborting the startup script before the container ever started. Fixed:
  detect a stray non-file at the render path and self-heal with a warning, rather than
  aborting.

### One bug found and fixed during development of the five-secret migration, before it ever reached a live host

`funcom_token_host_id()` originally used `${1:-default-path}` to decide whether to treat its
argument as a token value or fall back to reading the default flat file. This has a real,
subtle flaw: an **explicitly passed empty string** (e.g. the result of a *failed*
`resolve_funcom_token` call) is treated identically to *no argument at all* by `${1:-...}`,
silently falling back to re-reading the default file path — meaning a genuine resolver
failure could be silently masked by successfully reading a *different* (stale, or
unintentionally still-present) token from disk, rather than the failure propagating as an
error the way it should. Fixed to explicitly distinguish "argument not passed" from "argument
passed as an empty string" — confirmed via a dedicated regression test using a real,
synthetic, parseable JWT planted at the exact default path specifically to prove the fix
actually closes this gap (a test written without that fixture would have passed even with the
bug present, since the naive test setup's own missing-file fallback path coincidentally also
failed, for the wrong reason — this was caught and corrected during test development, not
assumed to be sufficient on the first attempt).

### Security note: why the token is piped via stdin, not passed as an environment variable

An earlier draft of the `funcom_token_host_id()` refactor considered passing the resolved
token value to its internal Python helper via an environment variable
(`TOKEN_VALUE=$token python3 ...`). This was caught and rejected before it ever reached a
commit: an environment variable is visible to any other process running as the same user via
`/proc/<pid>/environ`, for the entire lifetime of that process — a materially different but
comparably real exposure to the argv-based exposure (GHSA-fc89-h24v-6j3x) this whole feature
exists to eliminate. The final implementation pipes the token via stdin instead, confirmed
live via `strace -f -e trace=execve` to introduce zero new exposure (the traced `execve` for
the Python subprocess shows only the fixed, non-secret script text in its argv — the token
itself never appears in any captured `execve` call).

---

## Upgrade-Path Verification Evidence

This section exists because getting this wrong — breaking a real operator's deployment during
what should be a routine upgrade — is the single most serious risk this feature carries. Every
claim below was verified against this project's own real, live, production self-hosted server
(population confirmed at 0/60 throughout, with the operator's explicit knowledge and
authorization to proceed regardless of population for this specific verification work), not
inferred from reading the code or reasoned about in the abstract.

**Method:** for each of the five secrets migrated by this document, the exact sequence
verified was: (1) capture the live, running container's actual delivered environment
variables; (2) restart the relevant script(s) using the new, migrated code, with the age
backend deliberately left *unconfigured* (the default state every existing operator is
actually in on upgrade); (3) re-capture the container's environment variables; (4) confirm
byte-for-byte identity between the before and after capture, accounting only for Docker's own
non-deterministic ordering of its `.Config.Env` array (confirmed separately, by restarting the
same container twice in a row with no code changes at all between restarts, and observing the
same ordering non-determinism with zero underlying value changes — this is a Docker
characteristic unrelated to this feature, not a finding about this feature's correctness).

| Secret | Container(s) restarted | Result |
|---|---|---|
| Funcom token | `dune-server-gateway`, `dune-server-overmap` | Byte-identical `FuncomLiveServices__ServiceAuthToken` before/after, confirmed via `docker inspect`. |
| RMQ HTTP token-auth secret | `dune-server-gateway`, `dune-server-overmap`, `dune-text-router` | Byte-identical `RMQ_HTTP_TOKEN_AUTH_SECRET` before/after. |
| FLS API key | `dune-server-gateway`, `dune-server-overmap` | Byte-identical `fls-apikey`/`gateway_farm_api_key` before/after. |
| Server login password secret | `dune-server-overmap` (all five secret-derived env vars: `ServerLoginPasswordSecret`, `ServerLoginSecret`, `ChecksumSecret`, and their `AuthenticationConfiguration__...`/`BackendLoginConfiguration__...`-prefixed equivalents) | Byte-identical before/after. |
| Username server login secret | `dune-server-overmap` (`UsernameServerLoginSecret`, `UsernameSecret`, and prefixed equivalents) | Byte-identical before/after. |
| Postgres superuser password (no-op case) | `dune-postgres` | Confirmed the unconfigured fallback path (`postgres_superuser_password="postgres"`) is never entered into the age-backend branch at all — the entire new code path is skipped, byte-identical to pre-feature behavior. (The *configured* case — enabling the backend against an existing data directory — is covered by its own dedicated, automated regression test, `test-postgres-secrets-upgrade-path.sh`, and was separately live-verified earlier in this feature's development; see the PR history for that evidence specifically.) |

**Additionally, and separately from the byte-for-byte checks above**: `battlegroup-identity.sh
check` was run against the live host before and after every restart above, and returned
`Battlegroup identity is valid and matches the Funcom token` in every case — an
end-to-end functional check, not just an environment-variable comparison, confirming the
migrated `funcom_token_host_id()` refactor produces the correct result against this host's
real, live Funcom token.

### A real incident found *during* this verification — and why it is not a finding about this feature

While performing the verification above, `dune-server-survival-1` (a container this
verification work did **not** touch or restart) was found to be in a genuine `ERROR` state,
with its logs showing repeated Postgres "Invalid connection id, connection might have broken
or timed out" errors. This was investigated immediately and thoroughly, rather than assumed
to be either related or unrelated:

- The error's first occurrence in that container's logs was checked directly and found to
  predate the start of this verification session by **over three hours** (first occurrence
  at 23:41 UTC; this verification's first action was at 02:36 UTC the same night) — i.e., this
  container had already been running in a broken state, continuously, for hours before any
  of this feature's migrated code was ever exercised against it.
- `dune-postgres`'s own logs were checked for the same time window and showed no restarts, no
  connection drops, and no errors of any kind correlated with the game-server-side symptom —
  confirming the problem was isolated to that one game-server process's own stale connection
  pool, not a Postgres-side or secrets-related event.
- The container was restarted (with the operator's explicit authorization, given the server
  was confirmed at 0/60 population throughout) using the exact same migrated
  `start-server-survival-1.sh` code being verified in this document, and came back cleanly:
  no connection errors, normal map/partition loading, reached `READY` state, and all
  Funcom/FLS heartbeat and population-declaration checks returned to `OK`. Its secret
  delivery was independently confirmed byte-identical before and after this restart, exactly
  like every other container in the table above.

This is documented here in full, rather than silently omitted, because an accurate
upgrade-safety record has to include exactly this kind of finding — a real, live problem
discovered during testing — and be explicit about why it was or wasn't caused by the change
under test. It was not: the timeline, the Postgres-side log evidence, and the clean recovery
using the very code being verified all point to a pre-existing, unrelated infrastructure
condition on this specific host, not a regression introduced by this feature.

---

## What is NOT covered by this document

- **`admin-web-password.txt`, `admin-web-session-secret.txt`, `public-directory.json`** — read
  by the Node.js console (`console/api/src/config.js`), not by any shell script. Out of scope
  for this Bash library; a Node-side equivalent would need its own separate design.
- **`discord-adapter-token.txt`** — has zero live references anywhere in the current codebase.
  Nothing to migrate.
- **`command-auth-token.txt`** — declared but unused in `admin-tools.sh` (dead code). Not
  migrated. This specific secret has its own documented history of real production incidents
  caused by token-generation/rotation changes; touching it needs its own explicit, separate
  design decision, not an incidental inclusion here.
- **The `dune` role's own application password**, as consumed via `-DatabasePassword=` argv
  by the closed-source world-server binary — a separate, harder problem. Env-var delivery was
  tested twice against that binary and failed both times (the binary appears to require the
  literal argv form). This document's Postgres coverage only closes the **superuser**
  credential's exposure, not this one.

---

## Where things are stored

| Item | Path | Contents | Back up? |
|---|---|---|---|
| Age identity | wherever you chose (recommend `runtime/generated/.dune-age/identity.txt`) | Your root-of-trust private key, shared across every secret you migrate | **Yes — offline, durably, before you need it** |
| Encrypted KEK | wherever you chose (recommend `runtime/generated/.dune-age/kek.age`) | The wrapping key, itself encrypted with your identity, shared across every secret you migrate | Optional — can be regenerated from a new identity if needed, but backing it up alongside the identity avoids that step |
| Encrypted secrets | `runtime/secrets/<name>.enc` (one file per migrated secret) | The actual secret value, encrypted | Not required — regenerable from the still-present flat file for five of the six secrets, or via the break-glass procedure for Postgres specifically |
| Short-lived Postgres render file | `runtime/generated/.pg-superuser-password-runtime` | Plaintext password, mode 600, bind-mounted into the container | Never — this is regenerated on every startup and is not meant to persist |

None of these paths are included in `dune db backup` (which only backs up the Postgres
database contents itself), and all of them are git-ignored (`runtime/secrets/`,
`runtime/generated/` are both already excluded).
