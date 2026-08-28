# Console sign-in: upgrading an existing install

**Status: Current.** Verified 2026-08-27 by upgrading a live install running
v1.4.3 in place, with an authenticator already enrolled from an earlier build.

This guide is for operators who already run the console and want to know what
changes, what they need to do, and what they will see on screen. Nothing here
happens automatically — updating the console leaves your sign-in exactly as it
is until you deliberately turn the new option on.

## What sign-in options exist

| Option | Status | What it is |
|---|---|---|
| **Password** | Every install has this today | The admin password from `runtime/secrets/admin-web-password.txt` (or `ADMIN_PASSWORD`). |
| **Password + authenticator app** | New in this release, **off by default** | Your password plus a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.), with 10 one-time recovery codes for the day you lose your phone. |
| **Sign in with Discord** | New in this release, **off until configured** | People sign in with their Discord account and get console access from the roles they hold in your Discord server — owner, admin, moderator, or player. No shared password to hand out. |

Passkeys are **not** part of this release. If you have read about them in the
design document (`docs/rfc-console-auth.md`), that is the plan, not something
you can turn on today.

There is one admin account. If several people sign in to your console, they
share the password today and they will share the authenticator too. Read the
"Several people sign in" question at the end before turning this on.

## Before you start (five minutes)

Do these first. The one that bites people is the second.

1. **Install an authenticator app on your phone** if you do not have one.
2. **Decide where the recovery codes will live.** They are shown exactly once.
   A password manager is ideal; a printed sheet in a drawer is fine. Your
   notes app that syncs to the phone you might lose is not.
3. **Confirm you can reach the machine the console runs on** (SSH, or the
   physical box). If you ever lose both your phone and your recovery codes,
   that access is the only way back in — see "If something goes wrong".
4. **Check who else signs in**, and tell them. After you finish, their password
   alone will stop working.
5. **Back up `runtime/generated/`** if you back up anything. Your authenticator
   state will live there.

## Step 1 — update the console (nothing changes yet)

Update your checkout the way you normally do, then rebuild the console:

```bash
dune self-update install latest      # or `git pull` if you track a branch
dune console restart                 # rebuilds the image and restarts it
```

`dune console restart` is the important line. The new sign-in code and the
package it needs only land when the image is rebuilt.

Sign in as usual. **Nothing is different.** The option is off until Step 2.

## Step 2 — turn it on

Open `.env` in the repository root and set:

```ini
CONSOLE_TOTP_ENABLED=1
```

If the line is not there, add it (`.env.example` has the full description).
Then:

```bash
dune console restart
```

Do this when you are sitting in front of the console with your phone in hand
and somewhere to save the codes — not as part of an unattended deploy, because
of what happens next.

## Step 3 — your next sign-in sets up the authenticator

Enter your password as normal. Instead of the console, you will land on a
setup screen. This is expected. You have **10 minutes**; if it expires, just
sign in again to start over.

**Scan the QR code** with your authenticator app. If you cannot scan, click
*Can't scan? Enter this code manually* and type the code shown into the app.

**Enter the 6-digit code** the app now shows, to prove the pairing worked.

**Save your recovery codes.** The next screen says *Save your recovery codes*
and shows ten of them. This is the moment from the checklist: they are shown
once, right now, and never again. Each works only once. Store all ten, then
tick the acknowledgement and click *Continue to sign in*.

**Sign in again** with your password **and a fresh code** from the app. The
code you used to confirm the pairing will not work here — wait for the app to
show the next one. That is deliberate.

You are in. Setup is finished.

## Every sign-in from now on

Password, then the current 6-digit code. Codes change every 30 seconds and each
one can be used once, so if a code is rejected, wait for the next one rather
than retyping it. The sign-in page also offers *Lost access to your
authenticator?* for the day you need a recovery code instead.

## Managing it afterwards (Settings)

Two things change on the Settings page:

- **Login Password** now asks for a current authenticator code as well as your
  current password before it will change the password.
- A new **Two-Factor Authentication** section lets you **Regenerate Recovery
  Codes** — enter your password and a current code, and you get ten fresh
  ones. The old ten stop working the moment the new ones are issued. Do this if
  you have used several, or are not sure where the sheet went.

Your authenticator itself is not changed by either action.

## Running behind a reverse proxy or tunnel

Skip this section if the console is reached directly.

The console limits failed sign-in attempts per visitor address. Behind a proxy
or tunnel (nginx, Caddy, Cloudflare Tunnel, …) every visitor arrives from the
proxy's own address, so one person's typos can lock everyone out — including
you. Tell the console the proxy's exact IP address(es) so it uses the real
visitor address instead:

```ini
CONSOLE_TRUSTED_PROXY_IPS=127.0.0.1
```

Comma-separate several. Exact IPs only, no ranges. Leave it unset if there is
no proxy — that is the safe default. The console reads the **last** address the
trusted proxy appends to `X-Forwarded-For` (the real visitor), never the
client-supplied leftmost value, so a visitor cannot spoof the header. Only a
single trusted proxy hop is supported; chained proxies are out of scope.

## Discord sign-in requires HTTPS

Discord OAuth carries a one-time state cookie across the cross-site redirect
back from Discord. That cookie is `SameSite=None; Secure`, which browsers only
store over **HTTPS** — so the console must be reached through an HTTPS-terminating
front end (a reverse proxy or tunnel such as nginx, Caddy, or Cloudflare Tunnel)
for Discord sign-in to work. Over plain HTTP the cookie is dropped and every
Discord sign-in fails with *"invalid or expired"*. This is independent of
`ADMIN_SECURE_COOKIES`; password-only sign-in is unaffected. If you run several
consoles, give each its own Discord application (or rotate the secret per host)
rather than copying one production Client Secret onto a lower-trust host.

## Turning it off again

Set `CONSOLE_TOTP_ENABLED=0` (or remove the line) and run `dune console
restart`. Sign-in goes back to password only. Your authenticator state is
kept, so if you turn it back on later you do **not** set up again — your
existing app and recovery codes just start working again.

## If something goes wrong

**I lost my phone but I have my recovery codes.** On the sign-in page, click
*Lost access to your authenticator?*, enter your password and one recovery
code. You will be taken straight back to the setup screen to pair a new phone
and receive ten new codes — the old ones are retired. This is the normal path
and needs nothing from the server.

**I still have my phone but lost the codes.** Sign in normally and use
*Regenerate Recovery Codes* in Settings.

**I lost both.** There is no way back in from the sign-in page, on purpose — a
second factor that could be reset from the sign-in page would not be one. You
need access to the machine: follow *Case 3* in
[two-factor-recovery.md](two-factor-recovery.md). It is a two-minute
procedure, and your password is not affected.

**I set the flag and nothing happened.** Password sign-in still works with no
code and no setup screen. Almost always this means the container did not get
the setting: confirm you ran `dune console restart` *after* editing `.env`,
then check with
`docker inspect redblink-dune-docker-console --format '{{.Config.Env}}' | tr ' ' '\n' | grep CONSOLE_TOTP`.
If it prints nothing, the compose file in your checkout predates this feature —
update it.

**After updating, sign-in says my two-factor state was written by a newer
console.** You have rolled the console back to an older version than the one
that last ran. Your state is fine; **do not delete it**. Update the console
forward again and sign in normally.

**Sign-in says the two-factor state is unreadable.** The state file itself is
damaged. Restore `runtime/generated/console-second-factor.json` from a backup,
or — if you have no backup — remove it and set up again on your next sign-in,
exactly as in Step 3.

**My recovery codes were rejected and the message mentions a restored backup.**
The console noticed its state file is older than one it has seen before
(usually a restored backup) and retired every recovery code rather than risk
honouring one that had already been spent. Sign in with your authenticator
app, then regenerate the codes from Settings.

## Backups

Two files hold everything, both in `runtime/generated/` and both already
ignored by git:

```
console-second-factor.json             your authenticator + recovery codes (hashed)
console-second-factor.json.watermark   a small integrity marker
```

Back them up together and restore them together. If you restore only the first
from an old backup, expect the "restored backup" message above the first time
you use a recovery code — that is the marker doing its job.

## Sign in with Discord (role-based access)

Everything above is about the one shared admin account. Discord sign-in is
different: each person signs in as themselves, and what they can do in the
console comes from the roles they hold in your Discord server. Turning it on
does **not** change password sign-in — it adds a second button.

### What you need first

- A Discord server (the "home server") where your admins and players are members.
  **Its owner will be the console owner — automatically.** Discord has exactly
  one owner per server, and the console takes that as the truth; there is no
  owner setting anywhere.
- A Discord application: https://discord.com/developers/applications — create a
  **dedicated one for this console**. Its **name and icon are exactly what
  everyone sees on the Discord sign-in screen** ("*&lt;name&gt;* wants to access
  your account"), so name it for your server or console (for example your
  server's name, or "Dune Docker Console") and give it an icon. **Do not reuse
  the application your bot uses** — if you do, people signing in see the bot's
  name and icon and it looks like they are logging into the bot. Copy the app's
  **Client ID** and a **Client Secret**, and under its **OAuth2** settings add
  your console's callback as a redirect URI:
  `https://<your-console-host>/api/auth/discord/callback`. Registering the
  application is a one-time **deployment** step done in `.env` (below), the same
  as a bot token — the sign-in flow never asks anyone for it.
- Role IDs from your server, for the access levels below. Turn on Developer
  Mode in Discord (User Settings → Advanced), then right-click a role → **Copy
  Role ID**.

  | Console tier | What it can do (default policy) | Comes from |
  |---|---|---|
  | Owner | everything, including Settings | the server's owner — automatic |
  | Admin | run the server, players, bases, backups, updates — **not** Settings or the database | the role you map as Admin (required) |
  | Moderator | read everything, kick, broadcast | the role you map as Moderator |
  | Player | read-only views | the role you map as Player |

  A person holding several mapped roles gets the **highest** one. One role can
  be mapped to only one level — the console refuses anything else.

### Turning it on — the guided setup

**First, the one-time deployment step** (skip if the application is already in
`.env`): on the host, set these three in `.env` and run `dune console restart`:

```ini
DISCORD_OAUTH_CLIENT_ID=<the application's Client ID>
DISCORD_OAUTH_CLIENT_SECRET=<its Client Secret>   # or put it in runtime/secrets/discord-oauth-client-secret.txt (chmod 600)
DISCORD_OAUTH_REDIRECT_URI=https://<your-console-host>/api/auth/discord/callback
```

The setup screen shows you the exact redirect URI to register (with a copy
button) if you have not done it yet. The first-run sign-in flow never asks for
the client ID or secret — the application is deployment config. (Once set up,
**Settings → Discord OAuth** does expose a Client ID and Client Secret field,
for rotation; see below.)

**Rotating the Discord client secret.** If the secret ever leaks (in `.env`, a
screenshot, a paste), reset it in the Discord Developer Portal, then put the new
value on the console — either replace `runtime/secrets/discord-oauth-client-secret.txt`
(mode 0600) on the host, or paste it into **Settings → Discord OAuth → Client
Secret**. **A restart is required**: the console reads the secret only at
startup, so run `dune console restart` (or the in-app restart) after replacing
it, or token exchanges keep using the old secret and you will believe the
rotation took effect when it has not.

**Then, the guided part** (the console owner, in a browser):

1. On the sign-in page, click **Set up Discord sign-in** and enter the admin
   password. Only the console owner can connect Discord — without this step,
   anyone who owns some Discord server could point your console at it.
2. Click **Continue with Discord**. Discord asks you to authorize the
   application; nothing is signed in yet. You come back with everything Discord
   can tell the console already filled in: who you are and the server you own —
   that server makes you the console **Owner**.
3. Your server is chosen for you (only servers you own are offered; if you own
   more than one, pick it).
4. Type the role IDs — Admin (required), Moderator and Player (optional). Leave
   **Require two-factor for Owner and Admin** ticked unless you have a reason
   not to (it uses each person's own Discord-account 2FA, not the console
   password).
5. Click **Turn on Discord sign-in**. No password again — you already proved
   you are the owner when you started.
6. On the "done" screen, click **Restart the console now** — the console
   rebuilds and restarts itself, then reloads you into the new sign-in page.
   (Prefer to do it by hand? Run `dune console restart` on the host instead.)

Once Discord is on, the sign-in page leads with **Sign in with Discord**, and
the admin password moves to a secondary **Use the admin password instead**
link beneath it — your break-glass path if Discord is ever unavailable, so keep
the password (and, ideally, the authenticator from earlier in this guide).
Signing in with Discord never asks for the console password; the two are
independent methods, not a password-plus-Discord combination.

You can change the role mapping or the two-factor option later under
**Settings → Discord OAuth**, or run the guided setup again from there.

### Managing access afterwards

- **Settings → Discord OAuth** — change which Discord role maps to Admin,
  Moderator or Player, or the two-factor requirement, after setup. (There is no
  owner field: the owner is always the Discord server's owner.) Changes take a
  `dune console restart` to load.
- **Access Control** (sidebar, owner only) — edit what each tier is actually
  allowed to do. The console ships sensible defaults (Admin runs the server but
  cannot reach Settings or the database; Moderator and Player are read-plus a
  little), so most operators never need this. When you do want to tune a tier —
  say, let Admins export the database — this is where you do it, per tier,
  per action. It is hidden from everyone below owner, because deciding
  who-can-do-what is an owner's job, not an admin's.

### What people will see

The first time, Discord asks them to authorize the application — it needs to
read who they are and their roles in your server (nothing else, and it cannot
post as them). Then they land in the console with the tier their roles give
them. Tabs they may not use are hidden; the server refuses them regardless.

If they are refused, the page tells them why in plain words: not a member of
the server, no mapped role, or — with the 2FA option on — their Discord account
has no two-factor enabled (and names the Discord setting to fix it).

### Things to know

- **Password sign-in stays available** and is always the owner — it is the
  break-glass path. Keep it (and, ideally, the authenticator from earlier in
  this guide).
- **Owner is whoever owns the Discord server.** Transfer server ownership in
  Discord and the console owner changes with it at their next sign-in. There
  is no console-side override in the settings screen (an advanced `.env` key
  exists for additional owners, documented in `.env.example`).
- **Changing someone's Discord role takes effect at their next sign-in.** A
  person you demote keeps their current session until it expires or they sign
  out; restart the console to end every session at once.
- **Upgrading from an earlier build that already had Discord sign-in:** your
  existing owner list and bootstrap setting keep working unchanged. Because
  the console now reads roles, Discord asks each person to authorize the
  application once more. The 2FA requirement is off until you turn it on.
- **Running a companion bot with a signed tier handoff?** The bot stays the
  single source of truth; the role fields are ignored while the handoff is
  configured.

## Questions operators ask

**Several people sign in to my console. Do they each get their own
authenticator?** For the password account, no: one account, one authenticator,
one set of recovery codes. For per-person access, use *Sign in with Discord*
above — each person is themselves, and their Discord account's own 2FA can be
required.

**My password is set with `ADMIN_PASSWORD` in `.env`, not the file.** Password
+ authenticator works exactly the same. The only difference is one you already
have: the *Login Password* section in Settings cannot change an
environment-managed password, with or without this feature.

**I run with `ADMIN_AUTH_DISABLED=1`.** Then there is no password check, and
there is no authenticator check either — that setting bypasses sign-in
entirely and is meant for a console that is not reachable from anywhere
untrusted. Turning this feature on does not change that.

**Does this affect players or the game server?** No. It only changes how you
sign in to the web console. The game servers are separate containers and are
not restarted by any step here.

**Can I use a hardware key / passkey instead of a phone app?** Not in this
release. Any app that does standard time-based codes (TOTP) works, and most
password managers can act as one. (If your Discord account uses a security
key for 2FA, that already satisfies the Discord 2FA requirement above.)

## See also

- [two-factor-recovery.md](two-factor-recovery.md) — the lockout cases in
  detail, including the host-side reset.
- [API-REFERENCE.md](API-REFERENCE.md) — the endpoints behind all of this.
- `.env.example` — the full description of `CONSOLE_TOTP_ENABLED` and
  `CONSOLE_TRUSTED_PROXY_IPS`.
