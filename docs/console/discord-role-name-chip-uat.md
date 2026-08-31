# UAT: Discord role name in the signed-in chip (#573)

**Purpose.** A manual, end-user test plan for showing an operator's actual
Discord role name (instead of the bare access tier) in the console's
signed-in chip. Automated tests cover the resolver/session/API logic
(`console/api/test/{roleTiers,handoff,oauth,auth,config}.test.js`,
`console/api/test/oauthRoutes.integration.test.js`, and
`console/web/src/{App.roleNameChip,features/settings/SettingsPanel.discordRoleNames,features/settings/discordRoleNames}.test.{ts,tsx}`)
— this covers what a human operator actually sees, end to end, against a real
deployed build with real Discord sign-in.

**Who.** One QA engineer or operator, with a Discord server already
configured for console sign-in (`DISCORD_CONSOLE_ADMIN_ROLE_IDS` etc. already
set — see `docs/console/authentication-qa-checklist.md` Part 8 for setting
that up first if it isn't already). Budget about 40 minutes for T01–T10, plus
15 more for the optional T11–T12 if a companion bot with signed handoff is
also available.

**Result rule.** A case passes only if *every* expected line is observed. If
the chip's text, a Settings field's label/placeholder, or an error message
differs from what is written here, that is a finding even when the feature
still basically works — record the exact text you saw.

---

## Environment (fill in before starting)

| Item | Value |
|---|---|
| Console URL used in the browser | `https://________________` |
| Build under test | commit `________` (`git rev-parse --short HEAD` on the host) |
| Discord account with the console's mapped **Admin** role | account: `________` |
| Discord account with the console's mapped **Moderator** role | account: `________` (only needed for T07) |
| Discord account that is this guild's **owner** | account: `________` (only needed for T08) |
| Companion bot with signed tier handoff configured | yes / no — if no, skip T11–T12 |
| Host access (SSH) for T09–T10 | tester: `________` |
| Starting state | `DISCORD_CONSOLE_ROLE_NAMES` unset (no role names configured yet) — this is what every operator upgrading from the previous release has |

**Host paths referenced below** (relative to the repository root):
`.env`. Restart with `dune console restart`.

**Before starting, take a backup** on the host:
```bash
cp -p .env ~/qa-rolename-backup.env
```

---

## How to record results

For each case: **Pass / Fail / Blocked**, plus evidence — a screenshot of the
decisive screen, and the exact on-screen text for any message. Keep the
completed results table at the end with your test records for the build.

---

## Part 1 — Baseline (no role names configured)

### T01 · Chip shows the bare tier, exactly as before, when nothing is configured
1. Sign in to the console with the Discord account holding the mapped Admin role.
2. Look at the signed-in chip in the sidebar (next to the username).

**Expected**
- The chip reads `admin` (the bare tier), identical to before this feature existed.
- Hovering the chip still shows the tooltip `Console access tier: admin`.

---

## Part 2 — Configuring a role name in Settings

### T02 · The naming section is hidden until at least one role ID is configured
*Precondition:* as an owner or admin, open **Settings → Discord OAuth**.

**Expected**
- If no role ID field (Admin/Moderator/Player) has anything entered, there is
  **no** "Name your Discord roles" section at all — nothing to name yet.
- (If your install already has role IDs configured, as it should for this
  test plan, skip to T03 — you should already see the section.)

### T03 · One label input appears per configured role ID
1. In **Settings → Discord OAuth**, confirm the Admin Role field has exactly
   one role ID in it (matching the Environment table above).

**Expected**
- A "Name your Discord roles (optional)" section appears below the role-ID
  fields, with exactly one text input, labeled with that role's ID.
- The input's placeholder reads `e.g. Heavy Bats`.
- The help text above it explains the fallback: leaving it blank just shows
  the access level.

### T04 · Multiple role IDs in one field each get their own input
*Host:* temporarily add a second, made-up snowflake ID to the Admin Role
field (comma-separated), e.g. `<existing-id>,199999999999999999`, and save.
1. Reopen Settings → Discord OAuth (or just look again without navigating away).

**Expected**
- Two separate label inputs now appear, one per role ID, each labeled with
  its own ID.
- Revert this field back to just the one real ID and save again before
  continuing (this fake ID was only to prove the one-input-per-ID behavior).

### T05 · Saving a name persists it, survives a page reload, and takes effect after a restart
1. Type `Heavy Bats` into the Admin role's label input.
2. Click **Save Discord OAuth**.

**Expected**
- A result banner reads *Discord OAuth config saved. Restart the console for
  changes to take effect.*
3. Reload the Settings page (or navigate away and back to Discord OAuth).

**Expected**
- The label input still shows `Heavy Bats` — the saved value round-trips
  correctly through storage and back into the form.
4. Restart the console (`dune console restart` on the host, or via the
   Settings restart control if one is visible).
5. Sign out and sign back in as the Admin-role Discord account.

**Expected**
- The signed-in chip now reads `Heavy Bats`, not `admin`.
- The chip's underlying styling (color/badge) is unchanged from what `admin`
  looked like before — only the text changed.

### T06 · Clearing a label removes it, falling back to the tier again
1. In Settings → Discord OAuth, clear the Admin role's label input to empty.
2. Save, restart, sign out and back in as the same Admin account.

**Expected**
- The chip reads `admin` again (back to the pre-T05 baseline).

---

## Part 3 — Precedence and scoping (who gets a name, and whose)

### T07 · A member holding an Admin-mapped AND a Moderator-mapped role shows the Admin role's name, never the Moderator one
*Precondition:* re-save the Admin role's label as `Heavy Bats` (T05), and give
the Moderator role a label too, e.g. `Silencers`. Restart.
1. Using a Discord account that holds **both** the mapped Admin role and the
   mapped Moderator role, sign in.

**Expected**
- Signed in as `admin` (the higher tier, unchanged from before this feature).
- The chip reads `Heavy Bats` — the Admin role's name — never `Silencers`.

### T08 · The Discord server owner never shows a role name, even if they also hold a named role
*Precondition:* the account in the Environment table's "guild owner" row also
happens to hold the mapped Admin role (`Heavy Bats`).
1. Sign in as that account.

**Expected**
- Signed in as `owner` (ownership always wins, unchanged from before).
- The chip reads `owner` — plain tier text, **not** `Heavy Bats` — because
  owner is derived from Discord server ownership, not from any role, and a
  role name must never leak onto a tier it didn't decide.

---

## Part 4 — Resilience (host-level)

### T09 · A hand-edited, malformed `DISCORD_CONSOLE_ROLE_NAMES` degrades gracefully, never crashes the console
*Host:*
```bash
sed -i 's/^DISCORD_CONSOLE_ROLE_NAMES=.*/DISCORD_CONSOLE_ROLE_NAMES=not-valid-base64-or-json/' .env
dune console restart
```
1. Watch the console come back up (`dune status` or the health endpoint).
2. Sign in as the Admin-role account.

**Expected**
- The console restarts and comes up healthy — it does **not** crash or fail
  to start because of the malformed value.
- The chip falls back to `admin` (plain tier) — the malformed map is treated
  as if no names were configured at all, not as an error the operator sees.
3. Restore the value: `cp ~/qa-rolename-backup.env .env && dune console restart`.

### T10 · Removing the env var entirely is equivalent to never having configured it
*Host:*
```bash
sed -i '/^DISCORD_CONSOLE_ROLE_NAMES=/d' .env
dune console restart
```
1. Sign in as the Admin-role account.

**Expected**
- Chip reads `admin` — identical to the T01 baseline. Restore your backup
  afterward if you want to keep the configured names for further testing.

---

## Part 5 — Companion bot / signed handoff (optional — skip if no bot is configured)

### T11 · When a companion bot is configured, the bot's own role name wins over the local Settings label
*Precondition:* a companion bot with signed tier handoff enabled, sending its
own `roleName` for the deciding role. Also configure a **different** local
label for that same role ID in Settings (e.g. local says `Local Label`, bot
sends `Bot Label`).
1. Sign in as that role's Discord account.

**Expected**
- The chip reads `Bot Label` (the bot's own value) — never `Local Label`.
  This matches how the bot is already authoritative for the tier itself.

### T12 · A bot that sends no role name falls back to the tier, not the local map
*Precondition:* same bot/handoff setup as T11, but the bot's response omits
`roleName` entirely for this sign-in.
1. Sign in as the same role's Discord account.

**Expected**
- The chip reads the bare tier (e.g. `admin`) — it does **not** show
  `Local Label` either. On the handoff path, the local map is never
  consulted as a fallback; only the bot's own value or nothing.

---

## Results

| Case | Pass/Fail/Blocked | Notes |
|---|---|---|
| T01 | | |
| T02 | | |
| T03 | | |
| T04 | | |
| T05 | | |
| T06 | | |
| T07 | | |
| T08 | | |
| T09 | | |
| T10 | | |
| T11 (optional) | | |
| T12 (optional) | | |
