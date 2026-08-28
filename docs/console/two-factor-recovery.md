# Console two-factor: recovery and lockout

Applies to the password console login when `CONSOLE_TOTP_ENABLED=1`
(Tier 3 of the layered-auth design — see `docs/rfc-console-auth.md`
§2.3/§3.4/§4). If you have never set that flag, none of this applies to
you: your console login is unchanged, single-factor, and there is nothing
here to lose.

Read this **before** enabling the flag. The whole point of the document is
that the recovery paths are much easier to use while you still have
something to recover with.

## What you are given, and when

Enrollment happens once, on the first password login after the flag is
turned on. At the end of it the console shows you two things:

| Thing | Shown | Recoverable later? |
|---|---|---|
| The TOTP secret (as a QR code + a text fallback) | Once, during enrollment | No — but it lives in your authenticator app once scanned |
| 10 single-use recovery codes | Once, immediately after you confirm a code | **No.** Only hashes are stored. Save them then, or not at all |

Put the recovery codes somewhere that is not the console and not the
server — a password manager entry, or paper. They are the thing that saves
you when the phone with the authenticator on it dies.

## Case 1 — you lost the authenticator, you still have recovery codes

Use one at the login screen.

1. Enter your password as usual. The console will ask for an authenticator
   code.
2. Click **"Lost access to your authenticator?"**.
3. Enter your password and one unused recovery code.

That code is consumed, **every remaining code in the set is invalidated**,
and you are dropped into a forced re-enrollment: scan a new QR, confirm a
code, and you are issued a fresh set of 10 codes. Save those too.

This is deliberate. A recovery code is a one-shot escape hatch that always
lands you in a re-setup, never in a normal session — so a leaked code sheet
cannot be used quietly.

## Case 2 — you still have the authenticator, but lost the codes

Regenerate the set. Regenerating invalidates the old sheet completely; the
old one is worthless from that moment, which is the intent. You keep your
existing authenticator — this rotates the recovery codes only, and does not
sign out any of your other console sessions.

Open **Settings → Two-Factor Authentication → Regenerate Recovery Codes**, enter your
current login password and a code from your authenticator, and the console issues a
fresh set of 10. They are displayed once, behind a "I have saved these codes"
confirmation — only their digests are stored, so there is no way to retrieve them
afterwards.

The section only appears when a second factor is actually enrolled.

**History:** this page previously said to regenerate "from the
console's own settings" at a time when neither the route nor the control existed, so
anyone following it hit a dead end and the only real way back was the Case 3 host reset
below — which also destroys the TOTP enrollment. The dedicated regenerate route and the
settings control were added later; the instructions above now describe what is actually there.

## Case 3 — you lost both

There is no login-surface recovery. This is a deliberate, documented root
of trust, not an oversight: a second factor that could be reset without
host access would not be a second factor. The way back in is the host
filesystem.

```bash
# On the machine running the console:
cd /path/to/dune-awakening-selfhost-docker

# 1. Stop only the console, so nothing is mid-write when you delete the state.
#    Game servers are a separate compose file and are unaffected.
docker compose -f docker-compose.web.yml stop redblink-dune-docker-console

# 2. Delete the second-factor state. This one file, and only this one.
rm runtime/generated/console-second-factor.json

# 3. Bring the console back.
dune console restart
```

**Leave `console-second-factor.json.watermark` alone.** It is the
restore-detection high-water mark, it holds no credential, and
re-enrollment now seeds itself from it automatically, so nothing
is gained by removing it. Deleting it actively costs you something: it resets
the highest epoch ever observed to zero, so a genuinely restored older backup
some months from now would no longer be recognised as a rollback, and
previously-spent recovery codes could come back to life.

(An earlier revision of this page told you to delete both files. That was a
workaround for the earlier break-glass bug, where re-enrollment hardcoded its epoch to zero and so
landed behind a surviving watermark -- the console then treated your
brand-new codes as a restored backup and wiped all ten, unused, the first
time you tried to use one. The fix was to seed the epoch from the watermark
instead, which makes the second deletion both unnecessary and harmful.)

The install now has no TOTP state, so your next password login re-enters
the normal enrollment flow described above. Your password is unchanged
throughout — this resets the second factor, not the first.

If you would rather come back up single-factor and enroll later on your own
schedule, set `CONSOLE_TOTP_ENABLED=0` in `.env` before step 3. Rolling the
flag back off leaves any enrolled state intact.

`dune console status` will show you the container and the console URL once
it is back up.

**This means anyone with host filesystem access can reset your console's
second factor.** That is already true of everything else on the box (the
database, `runtime/secrets/`, the console binary itself), so it is not a
new exposure — but it is worth knowing rather than discovering.

## Case 4 — you did not enroll, and the console is already asking for a code

Someone or something else completed enrollment on this install. The
authenticator that was enrolled is not yours, so no code you can produce
will ever be accepted.

Check the audit log first, so you know what happened before you change
anything:

```bash
grep -E 'totp-setup|totp-regenerated|recovery-codes-regenerated|recovery-code-consumed|second-factor-reset-detected|auth\.2fa|auth\.login' \
  runtime/generated/web-admin-audit.jsonl | tail -20
```

**Corrected 2026-08-26:** this pattern previously matched only
`totp-setup|auth\.2fa|auth\.login`, which does **not** match
`settings.recovery-codes-regenerated` — the one event that explains a recovery
sheet that has stopped working. Anyone following this page saw an audit trail
that read as though nothing had touched the second factor, and reasonably
concluded the store was corrupt: straight to the Case 3 host reset, which also
destroys the TOTP enrollment. `auth.second-factor-reset-detected` was missing
for the same reason.

A `settings.recovery-codes-regenerated` entry means someone deliberately issued
a new sheet, invalidating yours; its `userId`/`tier` fields say who, and
`healedRollback: true` means it was the remedy for a detected restore-rollback
rather than a routine rotation. A `settings.totp-setup` entry tells you exactly
when enrollment was committed. If that timestamp lines up with a deploy, a test run, or someone
else's session, this is Case 3 — follow the reset above. If it does not
line up with anything you can account for, treat the shared
`ADMIN_PASSWORD` as compromised: rotate it *first*, then do the reset, then
enroll.

## A note on rate limiting

Failed login attempts are rate-limited. Behind a reverse proxy or a
Cloudflare tunnel the limiter currently sees the proxy's address rather than
each real client's, so repeated failed attempts can lock out everyone
reaching the console through that proxy for the lockout window, not just the
person typing. Give it the full window rather than retrying into the block.


## See also

- [authentication-upgrade-guide.md](authentication-upgrade-guide.md) — the
  operator walkthrough for turning this on in the first place.

- `docs/rfc-console-auth.md` §2.3 (Tier 3 design), §3.4 (credential loss,
  including the total-loss reset above), §4 (migration path)
- `.env.example` — the `CONSOLE_TOTP_ENABLED` block
