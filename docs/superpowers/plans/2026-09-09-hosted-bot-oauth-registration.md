# Hosted Bot Console-Initiated OAuth Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `mentat`'s DM-on-invite + `mentat-link` setup-portal onboarding with an in-console action in Core's Settings → Discord Bot section: a purpose-specific Discord OAuth round-trip, an owned-guild picker, and a server-to-server registration call to `mentat` that independently re-verifies guild ownership via the forwarded OAuth token.

**Architecture:** Three repos, one shared trust model. Core (`dune-awakening-selfhost-docker`) gets a new OAuth purpose (new callback path, new pending-registration store bridging the OAuth callback to a later confirm/register request via an opaque handle) and 3 new routes. `mentat` gets one new endpoint, exempted from its existing `requireProxySecret` middleware, gated only by independently re-verifying the forwarded Discord token against Discord's own API — never trusting Core's claim. `mentat-link` gets doc-only fixes.

**Tech Stack:** Node.js (`console/api`, `node:test`), React + TypeScript (`console/web`, Vitest), Node.js/Express (`mentat`, `node:test`), static HTML (`mentat-link`).

**Spec:** `docs/design/hosted-bot-oauth-registration-l1-design-2026-09-09.md` (Layer 1 design, Eight-Hats audit complete — 37 findings, all resolved; supplementary documentation-consistency pass also complete). Tracking issue: `dune-awakening-selfhost-docker#739`. Companion issues: `mentat#316`, `mentat-link#159`.

**Dependency:** This plan assumes `feat/discord-bot-adapter-settings-automation` (the sibling "Discord Bot Adapter Settings Automation" feature — Enable/Regenerate Token, the `choice` state, `DiscordBotSection.tsx`) is **already merged to `main`** before this plan's Core-side tasks begin. Every Core-side file/line reference below was verified against that branch directly, since it is not yet on `main` as of this plan's own authoring — re-verify against real `main` before starting Task 1 if there's any doubt it landed as described.

## Global Constraints

- No new Discord OAuth scope is requested — `OAUTH_SCOPES = "identify guilds"` in `oauth.js` is reused unchanged; `buildAuthorizeUrl()` hardcodes this scope with no parameter to override it, so this is structurally guaranteed, not just a discipline.
- The Discord access token never reaches the browser. What the browser holds between the OAuth callback and the confirm/register call is an opaque, single-use, short-TTL **handle** in a dedicated cookie — never the token itself, never in a URL or query string.
- `hosted-bot/oauth/start` and `.../callback` require the `updates:read` action (matching the real, existing `GET /api/settings/discord-bot` precedent — NOT `settings:read`, which does not exist as a mapped action for this section and would strand every admin-tier operator).
- `hosted-bot/register` requires a new, dedicated, owner-only action: `settings:discord-bot-hosted-register`. No `DEFAULT_POLICIES` changes are needed for either of the above — owner's `Action: "*"` and admin's `settings:*` Deny wildcard already cover them.
- "Connect to hosted bot" must be hard-gated on `choice === "hosted"`, both client-side (hide the button) and server-side (every new route re-checks this against a real, persisted value — never trust client-side hiding alone).
- `mentat`'s new `POST /api/consoles/register` endpoint must be exempted from `requireProxySecret` (an explicit, precisely-scoped `exemptPaths` addition — every other route keeps requiring the header, unchanged) and must independently re-verify guild ownership by calling Discord's own API with the forwarded token — it must never trust the `guildId` in the request body without this check.
- `mentat`'s new endpoint must reject a malformed token/guildId shape with zero calls to Discord (DoS bound), and rate-limit independently of `/setup/register`, keyed by the verified Discord user ID (once known) plus a hard global ceiling — never IP alone.
- The registration payload has no `roleMappings` field — role IDs stay exclusively in Core's own Settings → Discord Bot section.
- Core's outbound call to `mentat-backend.darkdante.org` uses a 15-second timeout and exactly one retry on 5xx/connection failure — never on 4xx.
- The Discord access token is never logged, never written to a session/cookie/database on either side, and never appears in a URL/query string.
- `/setup` and `POST /setup/register` in `mentat` are **not deleted** — they remain as a documented fallback.

---

## File Structure

**New files (`dune-awakening-selfhost-docker`):**
- `console/api/src/integrations/discord/hostedBotOAuth.js` — `fetchOwnedDiscordGuilds()`, the pending-registration store, cookie builders, the guilds-list-embedding return page.
- `console/api/src/services/httpWithRetry.js` — the generic outbound-HTTPS-with-timeout-and-one-retry helper.
- `console/api/test/hostedBotOAuth.test.js`, `console/api/test/httpWithRetry.test.js`, `console/api/test/hostedBotRegistrationRoutes.integration.test.js` — tests for the above.
- `console/web/src/api/discordHostedBotApi.ts` — frontend client for the 3 new routes.
- `docs/integrations/discord-control-bot/setup-guide.md` gets a new section (existing file, not new).

**Modified files (`dune-awakening-selfhost-docker`):**
- `console/api/src/integrations/discord/oauth.js` — export `constantTimeStringEqual`.
- `console/api/src/integrations/discord/adapterSettings.js` — persist `choice` (hosted/self-hosted) server-side.
- `console/api/src/actions.js`, `console/api/src/server.js` — 3 new routes + IAM entries.
- `console/web/src/features/settings/DiscordBotSection.tsx` — "Connect to hosted bot" button, OAuth flow, guild picker, persisted "Connected" status.
- `console/web/src/api/discordAdapterSettings.ts` — `choice` now sent to/read from the backend.

**New files (`mentat`):**
- `src/consoleRegistration.js` — the new `POST /api/consoles/register` route logic.
- `src/consoleRegistrationRateLimit.js` — the new endpoint's rate limiter.
- `test/consoleRegistration.test.js`, `test/consoleRegistrationRateLimit.test.js`.

**Modified files (`mentat`):**
- `src/setupServer.js` — `exemptPaths` addition, new route wiring.
- `src/onboarding.js`, `src/index.js` — remove the DM-on-invite trigger.
- `src/index.js` (or wherever commands dispatch) — in-guild "not registered" reply.
- `docs/setup-portal-guide.md`, `docs/admin-guide.md`, `docs/multi-tenant-design.md`, `docs/configuration.md`, `docs/discord-setup.md`, `docs/faq.md`, `docs/quick-start-guide.md`, `docs/installation-guide.md`, `README.md`, `USAGE.md`.

**Modified files (`mentat-link`):**
- `index.html` (2 sections), `docs/setup/index.html`, `docs/index.html`, `privacy.html`.

---

### Task 1: Export `constantTimeStringEqual` from `oauth.js`

**Files:**
- Modify: `console/api/src/integrations/discord/oauth.js`
- Test: `console/api/test/oauth.test.js` (check whether this file already exists with `ls console/api/test/oauth.test.js` — if it does, add to it; if not, create it)

**Interfaces:**
- Consumes: nothing new.
- Produces: `constantTimeStringEqual(left, right)` — now importable by other modules, needed by Task 3's pending-registration store.

The design's own §3.2 claimed this helper was "reused unchanged" from `oauth.js`, but it is currently module-private (not exported) — verified directly against the real file. This is a one-line fix, not a design gap: the function's real, current implementation (do not change its logic, only its export) is:

```js
function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0) return false;
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeStringEqual } from "../src/integrations/discord/oauth.js";

test("constantTimeStringEqual is exported and behaves correctly", () => {
  assert.equal(constantTimeStringEqual("abc", "abc"), true);
  assert.equal(constantTimeStringEqual("abc", "abd"), false);
  assert.equal(constantTimeStringEqual("abc", "ab"), false);
  assert.equal(constantTimeStringEqual("", ""), false, "empty-vs-empty must be false, matching the real function's own left.length === 0 short-circuit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console/api && node --test test/oauth.test.js`
Expected: FAIL with "constantTimeStringEqual is not a function" (not exported yet).

- [ ] **Step 3: Add the export**

In `console/api/src/integrations/discord/oauth.js`, find the line `function constantTimeStringEqual(left, right) {` and change it to `export function constantTimeStringEqual(left, right) {`. Do not change anything else in the function body.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console/api && node --test test/oauth.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full existing OAuth-related test suite to confirm no regression**

Run: `cd console/api && node --test test/*oauth* test/*Oauth* 2>/dev/null; node --test` (run the full suite if the targeted glob doesn't match anything — this is a one-line export change, but console-login OAuth is security-critical, confirm nothing else broke).
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add console/api/src/integrations/discord/oauth.js console/api/test/oauth.test.js
git commit -m "refactor(discord-oauth): export constantTimeStringEqual for reuse by the hosted-bot registration flow"
```

---

### Task 2: Persist the hosted/self-hosted `choice` server-side

**Files:**
- Modify: `console/api/src/integrations/discord/adapterSettings.js`
- Modify: `console/web/src/api/discordAdapterSettings.ts`
- Modify: `console/web/src/features/settings/DiscordBotSection.tsx`
- Test: `console/api/test/discordAdapterSettings.test.js`, `console/web/src/features/settings/DiscordBotSection.test.tsx`

**Interfaces:**
- Consumes: `updateEnvFileValues()` (existing, from `console/api/src/services/envFile.js`).
- Produces: `readDiscordBotSettingsState(config)` now also returns `deploymentChoice: "hosted" | "self-hosted" | null`; `enableDiscordBotAdapter()`/`updateDiscordBotRoleIds()` now accept and persist an optional `deploymentChoice` field. This is what Task 6's server-side gate check reads — without this task, there is no real, trustworthy source of truth for `choice` anywhere outside the browser's own `localStorage`.

**Real gap found during this plan's own research, not by the L1 audit:** `DiscordBotSection.tsx`'s `choice` state (`"hosted" | "self-hosted" | null`) is seeded from and written only to browser `localStorage` (`CHOICE_KEY = "arrakis.discordAdapterChoice"`, via `loadPersistedChoice()`/`persistChoice()`) — it is never sent to the backend and never returned by `readDiscordBotSettingsState()`. The design's own §3.1/§3.2 requires the new hosted-bot routes to "re-check this same condition server-side (reading the persisted `choice` value, not trusting client-side hiding alone)" — but no such persisted, server-readable value exists yet. This task creates it.

- [ ] **Step 1: Write the failing backend test**

Add to `console/api/test/discordAdapterSettings.test.js`:

```js
test("readDiscordBotSettingsState reports deploymentChoice as null when never set", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, null);
});

test("enableDiscordBotAdapter persists deploymentChoice, and readDiscordBotSettingsState reflects it", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-"));
  const result = enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "hosted" });
  assert.equal(result.ok, true);
  process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE = "hosted";
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, "hosted");
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
});

test("updateDiscordBotRoleIds persists an updated deploymentChoice without touching the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-update-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\n");
  writeFileSync(tokenFile, "existing-token\n");
  updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "self-hosted" });
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m);
  assert.equal(readFileSync(tokenFile, "utf8").trim(), "existing-token", "role-ID/choice updates must never touch the token file");
});
```

(Match this test file's real, existing imports for `mkdtempSync`/`mkdirSync`/`writeFileSync`/`readFileSync`/`tmpdir`/`join` — they should already be present per Task 8 of the sibling feature's own plan.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd console/api && node --test test/discordAdapterSettings.test.js`
Expected: FAIL — `deploymentChoice` doesn't exist yet, and `enableDiscordBotAdapter`/`updateDiscordBotRoleIds` don't accept a 3rd argument yet.

- [ ] **Step 3: Implement the persistence**

In `console/api/src/integrations/discord/adapterSettings.js`, find `MANAGED_ENV_KEYS` and add a new key:

```js
const MANAGED_ENV_KEYS = Object.freeze({
  enabled: "DUNE_DISCORD_ADAPTER_ENABLED",
  tokenFile: "DUNE_DISCORD_ADAPTER_TOKEN_FILE",
  directToken: "DUNE_DISCORD_ADAPTER_TOKEN",
  player: "DISCORD_PLAYER_ROLE_IDS",
  moderator: "DISCORD_MODERATOR_ROLE_IDS",
  admin: "DISCORD_ADMIN_ROLE_IDS",
  deploymentChoice: "DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE"
});
```

Add a small validation helper near the top of the file:

```js
function normalizeDeploymentChoice(value) {
  return value === "hosted" || value === "self-hosted" ? value : null;
}
```

In `readDiscordBotSettingsState()`, add to the returned object:

```js
    deploymentChoice: normalizeDeploymentChoice(process.env[MANAGED_ENV_KEYS.deploymentChoice] || null),
```

In `enableDiscordBotAdapter(config, roleIdsByTier = {}, options = {})` — add the 3rd parameter and, in the `updateEnvFileValues()` call, conditionally include the choice:

```js
export function enableDiscordBotAdapter(config, roleIdsByTier = {}, options = {}) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}

  const entries = [
    [MANAGED_ENV_KEYS.enabled, "true"],
    [MANAGED_ENV_KEYS.tokenFile, DEFAULT_TOKEN_FILE],
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ];
  const normalizedChoice = normalizeDeploymentChoice(options.deploymentChoice);
  if (normalizedChoice) entries.push([MANAGED_ENV_KEYS.deploymentChoice, normalizedChoice]);
  updateEnvFileValues(repoRoot, entries);

  process.env[MANAGED_ENV_KEYS.enabled] = "true";
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  process.env[MANAGED_ENV_KEYS.tokenFile] = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  if (normalizedChoice) process.env[MANAGED_ENV_KEYS.deploymentChoice] = normalizedChoice;

  return { ok: true, tokenFile: DEFAULT_TOKEN_FILE, token };
}
```

(This shows the full function per the no-placeholder rule; keep every other line exactly as it already exists on the sibling branch — only the signature, the `entries` array construction, and the two new lines are additions. If the real, current function on `main` after the sibling branch merge has a slightly different exact shape than shown here — e.g. different variable names — adapt this diff to match the real code, don't blindly overwrite it.)

Apply the equivalent, smaller change to `updateDiscordBotRoleIds(config, roleIdsByTier = {}, options = {})`:

```js
export function updateDiscordBotRoleIds(config, roleIdsByTier = {}, options = {}) {
  const entries = [
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ];
  const normalizedChoice = normalizeDeploymentChoice(options.deploymentChoice);
  if (normalizedChoice) entries.push([MANAGED_ENV_KEYS.deploymentChoice, normalizedChoice]);
  updateEnvFileValues(config.repoRoot, entries);
  if (normalizedChoice) process.env[MANAGED_ENV_KEYS.deploymentChoice] = normalizedChoice;
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd console/api && node --test test/discordAdapterSettings.test.js`
Expected: PASS, and confirm the full file's existing tests (from the sibling feature) still pass unchanged.

- [ ] **Step 5: Wire `choice` through the frontend so it's actually sent**

In `console/web/src/api/discordAdapterSettings.ts`, add `deploymentChoice?: "hosted" | "self-hosted" | null` to the `DiscordBotSettingsState` type, and add an optional `deploymentChoice` field to the `enable`/`updateRoleIds` request bodies' TypeScript types.

In `console/web/src/features/settings/DiscordBotSection.tsx`: seed `choice`'s `useState` initializer from `state?.deploymentChoice ?? loadPersistedChoice()` once `state` is available (falling back to the existing `localStorage` value before the first successful `refresh()`, so there's no regression for an operator who set `choice` before this change shipped), and include `deploymentChoice: choice` in the request bodies sent by `handleEnable`/`handleUpdateRoleIds`. Keep `persistChoice()`/`loadPersistedChoice()` as a fallback/cache, not the source of truth — the backend's returned `deploymentChoice` is now authoritative once available.

- [ ] **Step 6: Write a failing frontend test, then make it pass**

Add to `DiscordBotSection.test.tsx`:

```tsx
it("sends the current choice to the backend when enabling", async () => {
  mockApi.mockResolvedValue({ enabled: false, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: false, deploymentChoice: null } as never);
  mockPost.mockResolvedValue({ task: { id: "t1", type: "settings", operation: "discordAdapterApply", status: "queued", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: null, errorMessage: null }, token: "abc" } as never);
  render(<DiscordBotSection />);
  await screen.findByText(/Which are you using/i);
  fireEvent.click(screen.getByRole("button", { name: /Hosted bot/i }));
  fireEvent.click(screen.getByRole("button", { name: /Enable Discord Bot Integration/i }));
  await screen.findByText(/restart/i);
  fireEvent.click(await screen.findByRole("button", { name: /^Enable$/i }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-bot/enable", expect.objectContaining({ deploymentChoice: "hosted" })));
});
```

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`
Expected: FAIL first (confirming the field isn't sent yet), then implement Step 5's frontend change, then PASS.

- [ ] **Step 7: Commit**

```bash
git add console/api/src/integrations/discord/adapterSettings.js console/api/test/discordAdapterSettings.test.js console/web/src/api/discordAdapterSettings.ts console/web/src/features/settings/DiscordBotSection.tsx console/web/src/features/settings/DiscordBotSection.test.tsx
git commit -m "feat(settings): persist the hosted/self-hosted deployment choice server-side"
```

---

### Task 3: The `hostedBotOAuth.js` module — owned-guilds fetch, pending-registration store, cookies, return page

**Files:**
- Create: `console/api/src/integrations/discord/hostedBotOAuth.js`
- Test: `console/api/test/hostedBotOAuth.test.js`

**Interfaces:**
- Consumes: `discordJsonRequest`-equivalent Discord API calling (write a local copy — `oauth.js`'s own `discordJsonRequest` is module-private and not exported; duplicating this small, stable helper is simpler and safer than exporting internals of a security-critical module for a second caller), `constantTimeStringEqual` (Task 1).
- Produces: `fetchOwnedDiscordGuilds({ accessToken, apiBaseUrl, fetchImpl })`, `createPendingRegistrationStore({ now, ttlMs, maxEntries })`, `hostedBotOAuthStateCookie(value, secure)`, `clearHostedBotOAuthStateCookie(secure)`, `hostedBotRegistrationHandleCookie(value, secure)`, `clearHostedBotRegistrationHandleCookie(secure)`, `hostedBotOAuthReturnPage(ownedGuilds)`.

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { fetchOwnedDiscordGuilds, createPendingRegistrationStore, hostedBotOAuthStateCookie, hostedBotRegistrationHandleCookie, hostedBotOAuthReturnPage } from "../src/integrations/discord/hostedBotOAuth.js";

test("fetchOwnedDiscordGuilds keeps only owner:true guilds and preserves id+name+owner", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) {
      return { ok: true, json: async () => ([
        { id: "111111111111111111", name: "Owned Guild", owner: true },
        { id: "222222222222222222", name: "Not Owned", owner: false }
      ]) };
    }
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.equal(result.userId, "999999999999999999");
  assert.deepEqual(result.guilds, [{ id: "111111111111111111", name: "Owned Guild", owner: true }]);
});

test("fetchOwnedDiscordGuilds returns an empty guilds array when the operator owns nothing", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "1", name: "x", owner: false }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.deepEqual(result.guilds, []);
});

test("pending-registration store is single-use, TTL-bound, and capacity-capped", () => {
  let clock = 1000;
  const store = createPendingRegistrationStore({ now: () => clock, ttlMs: 5000, maxEntries: 2 });
  const first = store.issue({ accessToken: "tok-a", ownedGuildIds: ["111111111111111111"], userId: "u1" });
  assert.ok(first.handle);
  const readBack = store.consume(first.handle, first.handle);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.entry.accessToken, "tok-a");

  const secondRead = store.consume(first.handle, first.handle);
  assert.equal(secondRead.ok, false, "a handle must be single-use");

  const second = store.issue({ accessToken: "tok-b", ownedGuildIds: [], userId: "u2" });
  clock += 6000;
  const expired = store.consume(second.handle, second.handle);
  assert.equal(expired.ok, false, "an entry past its TTL must be rejected");
});

test("pending-registration store rejects a handle that doesn't match the cookie value", () => {
  const store = createPendingRegistrationStore({});
  const issued = store.issue({ accessToken: "tok", ownedGuildIds: [], userId: "u1" });
  const result = store.consume(issued.handle, "some-other-cookie-value");
  assert.equal(result.ok, false);
});

test("pending-registration store enforces a capacity cap", () => {
  const store = createPendingRegistrationStore({ maxEntries: 1 });
  const first = store.issue({ accessToken: "a", ownedGuildIds: [], userId: "u1" });
  assert.ok(first);
  const second = store.issue({ accessToken: "b", ownedGuildIds: [], userId: "u2" });
  assert.equal(second, null);
});

test("hostedBotOAuthStateCookie and hostedBotRegistrationHandleCookie use distinct, path-scoped, HttpOnly cookies", () => {
  const stateCookie = hostedBotOAuthStateCookie("abc123", true);
  assert.match(stateCookie, /^hosted_bot_oauth_state=abc123/);
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /Path=\/api\/integrations\/discord\/hosted-bot\/oauth\/callback/);
  const handleCookie = hostedBotRegistrationHandleCookie("xyz789", true);
  assert.match(handleCookie, /^hosted_bot_registration_handle=xyz789/);
  assert.match(handleCookie, /HttpOnly/);
  assert.notEqual(stateCookie.split("=")[0], handleCookie.split("=")[0], "the two cookies must have distinct names");
});

test("hostedBotOAuthReturnPage embeds the owned-guilds list as JSON the SPA can read, and never embeds a token", () => {
  const guilds = [{ id: "111111111111111111", name: "Test Guild", owner: true }];
  const page = hostedBotOAuthReturnPage(guilds);
  assert.match(page, /window\.__hostedBotOwnedGuilds__\s*=\s*\[/);
  assert.match(page, /Test Guild/);
  assert.doesNotMatch(page, /accessToken|access_token/i, "the return page must never embed the raw Discord token");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd console/api && node --test test/hostedBotOAuth.test.js`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the module**

Create `console/api/src/integrations/discord/hostedBotOAuth.js`:

```js
// hostedBotOAuth.js -- the "Connect to hosted bot" OAuth purpose. Deliberately
// a sibling to oauth.js (console-login OAuth), not a modification of it: this
// flow's callback must keep the `owner` field Discord returns per guild
// (oauth.js's own fetchDiscordIdentity() discards it, since console-login
// only ever needs guild-membership, not ownership), and needs its own cookie
// names/paths so the two flows can never be confused mid-flight.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constantTimeStringEqual } from "./oauth.js";

export const HOSTED_BOT_DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const HOSTED_BOT_REGISTRATION_TTL_MS = 10 * 60 * 1000;
export const HOSTED_BOT_MAX_PENDING_REGISTRATIONS = 256;

async function discordJsonRequest(url, init, { fetchImpl, label }) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error(`Discord ${label} request failed.`), { code: "discord_unreachable", statusCode: 502 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Discord rejected the ${label} request (HTTP ${response.status}).`), { code: "oauth_upstream_error", statusCode: 502 });
  }
  return response.json();
}

// fetchOwnedDiscordGuilds: a sibling to oauth.js's fetchDiscordIdentity(),
// kept separate because this one deliberately KEEPS the `owner` field
// Discord's own /users/@me/guilds response carries per guild -- the
// console-login flow's fetchDiscordIdentity() discards it, since login only
// ever needs membership, not ownership. Discord's `owner: true` means the
// literal Discord "Server Owner" for that guild, not merely an admin.
export async function fetchOwnedDiscordGuilds({ accessToken, apiBaseUrl = HOSTED_BOT_DISCORD_API_BASE_URL, fetchImpl = globalThis.fetch }) {
  const [user, guilds] = await Promise.all([
    discordJsonRequest(`${apiBaseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "identity" }),
    discordJsonRequest(`${apiBaseUrl}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "guilds" })
  ]);
  const userId = String(user?.id || "");
  const ownedGuilds = Array.isArray(guilds)
    ? guilds
        .filter((guild) => guild && guild.owner === true && /^\d{17,19}$/.test(String(guild.id || "")))
        .map((guild) => ({ id: String(guild.id), name: String(guild.name || "Unknown"), owner: true }))
    : [];
  return { userId, guilds: ownedGuilds };
}

// createPendingRegistrationStore: the token-custody fix from the L1 audit's
// CRITICAL finding. Modeled directly on oauth.js's own createPendingStateStore
// -- same shape (Map, capacity cap, TTL, single-use-on-read), but this store
// holds a live Discord access token + the caller's owned-guild IDs + userId,
// not a PKCE verifier. The browser only ever holds the returned `handle`
// (in a dedicated cookie, via hostedBotRegistrationHandleCookie below) --
// never the token itself.
export function createPendingRegistrationStore({
  now = () => Date.now(),
  ttlMs = HOSTED_BOT_REGISTRATION_TTL_MS,
  maxEntries = HOSTED_BOT_MAX_PENDING_REGISTRATIONS
} = {}) {
  const pending = new Map();

  function issue({ accessToken, ownedGuildIds, userId }) {
    if (pending.size >= maxEntries) return null;
    const handle = randomBytes(24).toString("base64url");
    pending.set(handle, { createdAt: now(), used: false, accessToken, ownedGuildIds, userId });
    return { handle };
  }

  function consume(handle, cookieValue, timestamp = now()) {
    if (typeof handle !== "string" || handle.length === 0 || handle.length > 128) {
      return { ok: false, reason: "invalid_handle" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_handle_cookie" };
    }
    const entry = pending.get(handle);
    pending.delete(handle);
    if (!entry || entry.used) return { ok: false, reason: "missing_or_reused_handle" };
    if (!constantTimeStringEqual(handle, cookieValue)) return { ok: false, reason: "handle_cookie_mismatch" };
    if (timestamp - entry.createdAt > ttlMs) return { ok: false, reason: "stale_handle" };
    entry.used = true;
    return { ok: true, entry };
  }

  return { issue, consume, size: () => pending.size };
}

// Deliberately a distinct name/path from oauth.js's own oauthStateCookie
// (Path=/api/auth/discord/callback) -- the two flows must never be
// confusable mid-flight, and this flow's own callback lives at a different
// path.
export function hostedBotOAuthStateCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_oauth_state=${encodeURIComponent(value)}; HttpOnly; SameSite=None; Path=/api/integrations/discord/hosted-bot/oauth/callback; Max-Age=600${securePart}`;
}

export function clearHostedBotOAuthStateCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_oauth_state=; HttpOnly; SameSite=None; Path=/api/integrations/discord/hosted-bot/oauth/callback; Max-Age=0${securePart}`;
}

// The registration-handle cookie is scoped to the whole /api/integrations/discord/hosted-bot/
// path (not just /callback) since /register (a different route under the
// same prefix) must also be able to read it.
export function hostedBotRegistrationHandleCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_registration_handle=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot; Max-Age=600${securePart}`;
}

export function clearHostedBotRegistrationHandleCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_registration_handle=; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot; Max-Age=0${securePart}`;
}

// hostedBotOAuthReturnPage: a sibling to server.js's own oauthReturnPage(),
// which takes no arguments and embeds nothing. This one MUST embed the
// owned-guilds list (id/name/owner only -- never the token, never the
// handle, which is already in a cookie the SPA doesn't need to read
// directly) so the SPA can render the guild picker without a second round
// trip. JSON.stringify + a basic HTML-escape on the whole blob defends
// against a guild name containing `</script>` (Discord guild names are
// free text, not snowflakes).
export function hostedBotOAuthReturnPage(ownedGuilds) {
  const safeJson = JSON.stringify(ownedGuilds || []).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connect to hosted bot</title></head><body><noscript><a href="/">Return to the console</a></noscript><script>window.__hostedBotOwnedGuilds__ = ${safeJson}; window.location.replace("/");</script></body></html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd console/api && node --test test/hostedBotOAuth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add console/api/src/integrations/discord/hostedBotOAuth.js console/api/test/hostedBotOAuth.test.js
git commit -m "feat(discord): add hostedBotOAuth module (owned-guilds fetch, pending-registration store, cookies, return page)"
```

---

### Task 4: The outbound-HTTPS-with-timeout-and-retry helper

**Files:**
- Create: `console/api/src/services/httpWithRetry.js`
- Test: `console/api/test/httpWithRetry.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fetchWithTimeoutAndRetry(url, init, { timeoutMs, fetchImpl })` — used by Task 6's `/register` route handler for the outbound call to `mentat-backend.darkdante.org`.

**Verified during this plan's own research: no existing helper in this codebase does this** (the closest analog, `addons.js`'s community-catalog fetch, uses a timeout but falls back to a stale cache rather than retrying the request itself) — this is genuinely new code, not a design gap.

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeoutAndRetry } from "../src/services/httpWithRetry.js";

test("returns the response on a successful first attempt, no retry", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200 }; };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("retries exactly once on a 5xx, then returns the retry's result", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("does not retry on a 4xx", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 400 }; };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 400);
  assert.equal(calls, 1);
});

test("retries exactly once on a connection-level failure, then rethrows if the retry also fails", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("connection reset"); };
  await assert.rejects(() => fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl }), /connection reset/);
  assert.equal(calls, 2);
});

test("aborts a call that exceeds the timeout", async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  await assert.rejects(() => fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl, timeoutMs: 10 }), /aborted/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd console/api && node --test test/httpWithRetry.test.js`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the helper**

Create `console/api/src/services/httpWithRetry.js`:

```js
// httpWithRetry.js -- a real timeout + single-retry-on-5xx-or-connection-
// failure policy for outbound server-to-server calls. Verified during
// planning: no existing helper in this codebase does this (addons.js's
// community-catalog fetch has a timeout but falls back to a stale cache on
// failure, rather than retrying the request itself) -- this is new,
// standalone code, reused wherever this exact policy is needed (currently:
// Core's call to mentat-backend.darkdante.org for hosted-bot registration).
const DEFAULT_TIMEOUT_MS = 15000;

async function attemptOnce(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// fetchWithTimeoutAndRetry: exactly one retry, only on a 5xx response or a
// connection-level failure (thrown error, including our own abort) -- never
// on a 4xx, since retrying an already-rejected request wastes whatever
// rate-limit budget the caller is trying to protect.
export async function fetchWithTimeoutAndRetry(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  try {
    const first = await attemptOnce(url, init, fetchImpl, timeoutMs);
    if (first.ok || (first.status >= 400 && first.status < 500)) return first;
    return await attemptOnce(url, init, fetchImpl, timeoutMs);
  } catch (firstError) {
    return await attemptOnce(url, init, fetchImpl, timeoutMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd console/api && node --test test/httpWithRetry.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add console/api/src/services/httpWithRetry.js console/api/test/httpWithRetry.test.js
git commit -m "feat(services): add a real timeout+single-retry-on-5xx helper for outbound server-to-server calls"
```

---

### Task 5: IAM actions for the 3 new routes

**Files:**
- Modify: `console/api/src/actions.js`
- Test: `console/api/test/hostedBotOAuthPolicy.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `actionForRoute("GET /api/integrations/discord/hosted-bot/oauth/start", "GET")` → `"updates:read"`; `.../callback` → `"updates:read"`; `actionForRoute("POST /api/integrations/discord/hosted-bot/register", "POST")` → `"settings:discord-bot-hosted-register"`.

- [ ] **Step 1: Add the 3 new route entries**

In `console/api/src/actions.js`, near the existing `--- Discord Bot Adapter Settings ---` section (the sibling feature's own entries), add:

```js
  // --- Hosted Bot Registration ---
  // start/callback use updates:read (the same real precedent as
  // GET /api/settings/discord-bot -- NOT settings:read, which does not
  // exist as a mapped action for this section and would strand every
  // admin-tier operator; verified against the sibling feature's own
  // ROUTE_ACTIONS entries during this plan's own research).
  "GET /api/integrations/discord/hosted-bot/oauth/start":    "updates:read",
  "GET /api/integrations/discord/hosted-bot/oauth/callback": "updates:read",
  // register is a new, dedicated, owner-only action -- this route forwards
  // a live external OAuth credential and the local adapter secret across
  // an organizational trust boundary, at least as sensitive as this
  // codebase's own existing settings:discord-bot-regenerate-token
  // precedent (also owner-only via the same settings:* Deny wildcard).
  "POST /api/integrations/discord/hosted-bot/register":      "settings:discord-bot-hosted-register",
```

- [ ] **Step 2: Write the policy-resolution test**

Create `console/api/test/hostedBotOAuthPolicy.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("hosted-bot routes resolve to the expected actions", () => {
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/start", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/callback", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/register", "POST"), "settings:discord-bot-hosted-register");
});

test("admin can start/callback the OAuth flow (updates:read) but cannot register (owner-only)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-hosted-register"), false);
});

test("owner can do both, with zero DEFAULT_POLICIES changes required", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-hosted-register"), true);
});
```

(If `evaluate()`'s real call signature differs from `evaluate(session, action)`, check `console/api/src/policy.js`'s real export and adjust — this was confirmed as the real signature during this plan's own research, but re-verify directly before running.)

- [ ] **Step 3: Run test to verify it passes**

Run: `cd console/api && node --test test/hostedBotOAuthPolicy.test.js`
Expected: PASS — no `policy.js` changes needed (confirmed by direct trace through `matchAction()`/`evaluate()` during this plan's research: owner's `Action: "*"` and admin's `settings:*` Deny wildcard already cover the new action string with zero edits).

- [ ] **Step 4: Commit**

```bash
git add console/api/src/actions.js console/api/test/hostedBotOAuthPolicy.test.js
git commit -m "feat(discord): add IAM actions for the 3 hosted-bot registration routes"
```

---

### Task 6: The 3 new routes in `server.js`

**Files:**
- Modify: `console/api/src/server.js`
- Test: `console/api/test/hostedBotRegistrationRoutes.integration.test.js`

**Interfaces:**
- Consumes: `fetchOwnedDiscordGuilds`, `createPendingRegistrationStore`, the 4 cookie functions, `hostedBotOAuthReturnPage` (Task 3); `fetchWithTimeoutAndRetry` (Task 4); `readDiscordBotSettingsState` (Task 2, for the `deploymentChoice`/`choice==="hosted"` gate and reading the adapter token); `exchangeDiscordAuthCode`, `buildAuthorizeUrl` (existing, `oauth.js`).
- Produces: the 3 live routes.

**Critical placement note, verified during this plan's research:** unlike console-login's OAuth routes (`/api/auth/discord/start`/`/callback`), which are deliberately dispatched *before* the console session/auth gate (since a not-yet-logged-in operator needs them to log in at all), these 3 new routes require an *already-logged-in* console session — they must be dispatched *after* `const session = auth.requireAuth(req, res); ... req.authSession = session;` and the `evaluate()` IAM check, not alongside the pre-auth OAuth block. Find that gate (it's the same one the sibling feature's own `/api/settings/discord-bot*` routes are dispatched after) and add these 3 routes in that same post-auth section.

- [ ] **Step 1: Read the real, current file to confirm the exact post-auth dispatch location**

Run: `grep -n "req.authSession = session\|actionForRoute(path, req.method)\|/api/settings/discord-bot\"" console/api/src/server.js`

Confirm the post-auth gate's real current line numbers, and find where the sibling feature's own 4 `/api/settings/discord-bot*` route bodies are dispatched — add the 3 new routes in that same block, immediately after them, not before the auth gate.

- [ ] **Step 2: Add the import**

Near the sibling feature's own `adapterSettings.js` import in `server.js`, add:

```js
import { fetchOwnedDiscordGuilds, createPendingRegistrationStore, hostedBotOAuthStateCookie, clearHostedBotOAuthStateCookie, hostedBotRegistrationHandleCookie, clearHostedBotRegistrationHandleCookie, hostedBotOAuthReturnPage } from "./integrations/discord/hostedBotOAuth.js";
import { fetchWithTimeoutAndRetry } from "./services/httpWithRetry.js";
```

Near wherever `oauthPendingStates` (the existing console-login `createPendingStateStore()` instance) is instantiated at module scope, add a sibling instance:

```js
const hostedBotPendingRegistrations = createPendingRegistrationStore();
```

- [ ] **Step 3: Write the failing integration test**

Create `console/api/test/hostedBotRegistrationRoutes.integration.test.js`, following the exact real spawn-and-fetch pattern already established by the sibling feature's own `discordAdapterSettingsRoutes.integration.test.js` (spawn the real server, use `startFakeBot`/a real session cookie where an authenticated test is needed — check that file's exact setup code and mirror it):

```js
import assert from "node:assert/strict";
import test from "node:test";
// mirror the exact spawn/session-cookie setup from
// discordAdapterSettingsRoutes.integration.test.js -- import whatever
// helper it uses (e.g. startConsole, startFakeBot) rather than
// reimplementing server-spawning here.
import { startConsole } from "./helpers/testServer.js"; // adjust to the real, existing helper's actual path/name found in the sibling test file

test("GET /api/integrations/discord/hosted-bot/oauth/start requires a real session (401/403 unauthenticated)", async () => {
  const console_ = await startConsole();
  try {
    const res = await fetch(`${console_.baseUrl}/api/integrations/discord/hosted-bot/oauth/start`);
    assert.ok(res.status === 401 || res.status === 403);
  } finally {
    await console_.stop();
  }
});

test("hosted-bot/register requires owner tier -- an admin-tier session gets 403 and no outbound call is made", async () => {
  const console_ = await startConsole();
  try {
    const adminCookie = await console_.loginAs("admin"); // adjust to the real helper's real method name
    const res = await fetch(`${console_.baseUrl}/api/integrations/discord/hosted-bot/register`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json", "x-csrf-token": await console_.getCsrfToken(adminCookie) },
      body: JSON.stringify({ guildId: "111111111111111111" })
    });
    assert.equal(res.status, 403);
  } finally {
    await console_.stop();
  }
});

test("hosted-bot/register with choice !== \"hosted\" is blocked server-side even for owner", async () => {
  const console_ = await startConsole();
  try {
    const ownerCookie = await console_.loginAs("owner");
    // deploymentChoice deliberately left unset/self-hosted on this console instance
    const res = await fetch(`${console_.baseUrl}/api/integrations/discord/hosted-bot/register`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/json", "x-csrf-token": await console_.getCsrfToken(ownerCookie) },
      body: JSON.stringify({ guildId: "111111111111111111" })
    });
    assert.equal(res.status, 403);
  } finally {
    await console_.stop();
  }
});
```

(These 3 tests are the load-bearing ones for this task's own IAM/gating claims. Adjust the exact helper import/method names to match whatever real test-server helper the sibling integration test file actually uses — check it directly first with `cat console/api/test/discordAdapterSettingsRoutes.integration.test.js | head -60` before writing the final version of this file, since the plan's own research did not capture that helper's exact API.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd console/api && node --test test/hostedBotRegistrationRoutes.integration.test.js`
Expected: FAIL — the routes don't exist yet (404s, not the expected 401/403).

- [ ] **Step 5: Implement the 3 routes**

In `console/api/src/server.js`, in the post-auth dispatch block (Step 1's location), add:

```js
  if (path === "/api/integrations/discord/hosted-bot/oauth/start" && req.method === "GET") {
    if (!config.discordOAuthClientId || !config.discordOAuthClientSecret) {
      return html(res, 200, oauthErrorPage("Discord sign-in isn't configured for this console yet. Set it up in Settings -> Discord OAuth first, then try connecting to the hosted bot again."));
    }
    const state = require("node:crypto").randomBytes(16).toString("base64url");
    res.setHeader("Set-Cookie", hostedBotOAuthStateCookie(state, config.secureCookies));
    const authorizeUrl = buildAuthorizeUrl({ clientId: config.discordOAuthClientId, redirectUri: config.discordHostedBotOAuthRedirectUri, state });
    res.writeHead(302, { Location: authorizeUrl });
    res.end();
    audit(config, req, "hosted-bot.oauth.start", {});
    return;
  }

  if (path === "/api/integrations/discord/hosted-bot/oauth/callback" && req.method === "GET") {
    const url = new URL(req.url || "", "http://localhost");
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const cookieState = parseCookies(req.headers.cookie || "").get("hosted_bot_oauth_state") || "";
    if (!constantTimeStringEqual(state, cookieState) || !state) {
      return html(res, 400, oauthErrorPage("This request was invalid or expired. Go back to Settings and try connecting to the hosted bot again."));
    }
    let token;
    let owned;
    try {
      token = await exchangeDiscordAuthCode({
        code,
        redirectUri: config.discordHostedBotOAuthRedirectUri,
        clientId: config.discordOAuthClientId,
        clientSecret: config.discordOAuthClientSecret
      });
      owned = await fetchOwnedDiscordGuilds({ accessToken: token.access_token });
    } catch (error) {
      audit(config, req, "hosted-bot.oauth.callback", { ok: false, reason: error.code || "oauth_error" });
      return html(res, 400, oauthErrorPage("Connecting to Discord failed. Go back to Settings and try again."));
    }
    const pending = hostedBotPendingRegistrations.issue({
      accessToken: token.access_token,
      ownedGuildIds: owned.guilds.map((g) => g.id),
      userId: owned.userId
    });
    if (!pending) {
      return html(res, 429, oauthErrorPage("Too many connection attempts in progress. Try again in a moment."));
    }
    res.setHeader("Set-Cookie", [hostedBotRegistrationHandleCookie(pending.handle, config.secureCookies), clearHostedBotOAuthStateCookie(config.secureCookies)]);
    audit(config, req, "hosted-bot.oauth.callback", { ok: true, ownedGuildCount: owned.guilds.length });
    return html(res, 200, hostedBotOAuthReturnPage(owned.guilds));
  }

  if (path === "/api/integrations/discord/hosted-bot/register" && req.method === "POST") {
    const state = readDiscordBotSettingsState(config);
    if (state.deploymentChoice !== "hosted") {
      audit(config, req, "hosted-bot.register", { ok: false, reason: "not_hosted_choice" });
      return json(res, 403, { error: "This console isn't configured for the hosted bot." });
    }
    if (!state.tokenConfigured) {
      audit(config, req, "hosted-bot.register", { ok: false, reason: "no_adapter_token" });
      return json(res, 400, { error: "Your console doesn't have an adapter token configured yet -- enable the adapter first." });
    }
    const handleCookie = parseCookies(req.headers.cookie || "").get("hosted_bot_registration_handle") || "";
    const body = await readJson(req);
    const guildId = String(body.guildId || "");
    const consumed = hostedBotPendingRegistrations.consume(handleCookie, handleCookie);
    if (!consumed.ok) {
      audit(config, req, "hosted-bot.register", { ok: false, reason: consumed.reason });
      return json(res, 400, { error: "Reconnecting to Discord to confirm this is still you...", needsReauth: true });
    }
    if (!consumed.entry.ownedGuildIds.includes(guildId)) {
      audit(config, req, "hosted-bot.register", { ok: false, reason: "guild_not_owned" });
      return json(res, 403, { error: "Could not verify you own that Discord server -- please try connecting again." });
    }
    const adapterToken = readDiscordAdapterTokenForHostedBot(config);
    let mentatResponse;
    try {
      mentatResponse = await fetchWithTimeoutAndRetry(
        "https://mentat-backend.darkdante.org/api/consoles/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            guildId,
            discordAccessToken: consumed.entry.accessToken,
            consoleUrl: body.consoleUrl || "",
            adapterToken
          })
        },
        { timeoutMs: 15000 }
      );
    } catch {
      audit(config, req, "hosted-bot.register", { ok: false, reason: "mentat_unreachable" });
      return json(res, 502, { error: "Couldn't reach the hosted bot service. Your console's own settings are unaffected -- try again in a moment." });
    }
    if (!mentatResponse.ok) {
      audit(config, req, "hosted-bot.register", { ok: false, reason: "mentat_rejected", status: mentatResponse.status });
      return json(res, 502, { error: "Could not verify you own that Discord server -- please try connecting again." });
    }
    audit(config, req, "hosted-bot.register", { ok: true, guildId });
    return json(res, 200, { ok: true });
  }
```

(This shows the full, real logic per the no-placeholder rule. `constantTimeStringEqual` here is imported from `oauth.js` per Task 1. `readDiscordAdapterTokenForHostedBot(config)` is a small helper you'll need to add — it should read the SAME token file `readDiscordBotApiToken()` in `routes.js` already reads, since the value forwarded to mentat must be byte-identical to what the console's own adapter validates against; check `routes.js`'s real `readDiscordBotApiToken()` and either export/reuse it directly if its signature fits, or write a one-line wrapper. `config.discordHostedBotOAuthRedirectUri` is a new config value — add it to `config.js` alongside the existing `discordOAuthRedirectUri`, documented in `.env.example`, and note in this task's own commit message that every existing operator wanting this feature must register this second redirect URI in their own Discord Developer Portal app, per the design's §6.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd console/api && node --test test/hostedBotRegistrationRoutes.integration.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full backend suite**

Run: `cd console/api && node --test`
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
git add console/api/src/server.js console/api/src/config.js console/api/test/hostedBotRegistrationRoutes.integration.test.js
git commit -m "feat(discord): add the 3 hosted-bot registration routes"
```

---

### Task 7: Frontend API client

**Files:**
- Create: `console/web/src/api/discordHostedBotApi.ts`
- Test: none needed beyond `tsc --noEmit` — this is a thin, typed pass-through (matching the sibling feature's own `discordAdapterSettings.ts`, which also has no dedicated test file).

**Interfaces:**
- Consumes: `api`, `post` from `./client`.
- Produces: `discordHostedBotApi.startOAuth()`, `.getOwnedGuilds()` (reads `window.__hostedBotOwnedGuilds__`, set by Task 3's return page), `.register(guildId, consoleUrl)`.

- [ ] **Step 1: Implement the client**

Create `console/web/src/api/discordHostedBotApi.ts`:

```ts
export type OwnedDiscordGuild = { id: string; name: string; owner: true };

export const discordHostedBotApi = {
  startOAuthUrl: () => "/api/integrations/discord/hosted-bot/oauth/start",
  readOwnedGuildsFromWindow: (): OwnedDiscordGuild[] => {
    const w = window as unknown as { __hostedBotOwnedGuilds__?: OwnedDiscordGuild[] };
    const guilds = w.__hostedBotOwnedGuilds__ ?? [];
    delete w.__hostedBotOwnedGuilds__;
    return guilds;
  },
  register: (guildId: string, consoleUrl: string) => {
    return import("./client").then(({ post }) => post<{ ok: boolean }>("/api/integrations/discord/hosted-bot/register", { guildId, consoleUrl }));
  }
};
```

- [ ] **Step 2: Type-check**

Run: `cd console/web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add console/web/src/api/discordHostedBotApi.ts
git commit -m "feat(discord): add frontend client for hosted-bot registration"
```

---

### Task 8: `DiscordBotSection.tsx` — "Connect to hosted bot" UI

**Files:**
- Modify: `console/web/src/features/settings/DiscordBotSection.tsx`
- Test: `console/web/src/features/settings/DiscordBotSection.test.tsx`

**Interfaces:**
- Consumes: `discordHostedBotApi` (Task 7); the existing `ConfirmDialog` pattern; `state.deploymentChoice` (Task 2).
- Produces: a new "Connect to hosted bot" button in the `enabled` phase, gated on `choice === "hosted"`.

- [ ] **Step 1: Write the failing tests**

Add to `DiscordBotSection.test.tsx`:

```tsx
it("shows Connect to hosted bot only when choice is hosted, never for self-hosted", async () => {
  mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "self-hosted" } as never);
  render(<DiscordBotSection />);
  await screen.findByText(/Enabled/i);
  expect(screen.queryByRole("button", { name: /Connect to hosted bot/i })).toBeNull();
});

it("clicking Connect to hosted bot navigates to the OAuth start route after an explicit disclosure confirm", async () => {
  mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
  const originalLocation = window.location;
  // @ts-expect-error -- test-only reassignment
  delete window.location;
  // @ts-expect-error -- test-only reassignment
  window.location = { ...originalLocation, href: "" };
  render(<DiscordBotSection />);
  await screen.findByText(/Enabled/i);
  fireEvent.click(screen.getByRole("button", { name: /Connect to hosted bot/i }));
  await screen.findByText(/independently verified/i);
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
  await waitFor(() => expect(window.location.href).toBe("/api/integrations/discord/hosted-bot/oauth/start"));
  window.location = originalLocation;
});

it("renders the owned-guilds picker from window.__hostedBotOwnedGuilds__ on mount when present", async () => {
  mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
  (window as any).__hostedBotOwnedGuilds__ = [{ id: "111111111111111111", name: "My Test Guild", owner: true }];
  render(<DiscordBotSection />);
  await screen.findByText(/Which server is this for/i);
  expect(screen.getByText("My Test Guild")).toBeInTheDocument();
});

it("registering a picked guild calls discordHostedBotApi.register and shows the persisted Connected status", async () => {
  mockApi.mockResolvedValue({ enabled: true, roleIds: { player: [], moderator: [], admin: [] }, tokenConfigured: true, deploymentChoice: "hosted" } as never);
  (window as any).__hostedBotOwnedGuilds__ = [{ id: "111111111111111111", name: "My Test Guild", owner: true }];
  mockPost.mockResolvedValue({ ok: true } as never);
  render(<DiscordBotSection />);
  await screen.findByText(/Which server is this for/i);
  fireEvent.click(screen.getByText("My Test Guild"));
  fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/integrations/discord/hosted-bot/register", expect.objectContaining({ guildId: "111111111111111111" })));
  await screen.findByText(/Connected to hosted bot for My Test Guild/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`
Expected: FAIL — the button/picker don't exist yet.

- [ ] **Step 3: Implement**

In `console/web/src/features/settings/DiscordBotSection.tsx`, add near the top:

```tsx
import { discordHostedBotApi, type OwnedDiscordGuild } from "../../api/discordHostedBotApi";
```

Add new state (alongside the existing `choice`/`revealedToken`/etc. state declarations):

```tsx
const [ownedGuilds, setOwnedGuilds] = useState<OwnedDiscordGuild[] | null>(() => {
  const fromWindow = discordHostedBotApi.readOwnedGuildsFromWindow();
  return fromWindow.length > 0 ? fromWindow : null;
});
const [pickedGuild, setPickedGuild] = useState<OwnedDiscordGuild | null>(null);
const [connectedGuildName, setConnectedGuildName] = useState<string | null>(null);
```

Add the handler for the "Connect to hosted bot" button, using the existing `ConfirmDialog` pattern:

```tsx
async function handleConnectToHostedBot() {
  setError("");
  const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
    setConfirmRequest({
      title: "Connect to hosted bot",
      message: "Your Discord authorization will be used once to verify you own this server, then sent to and independently verified by the hosted bot service (mentat), and discarded -- it is never stored.",
      confirmLabel: "Connect",
      cancelLabel: "Cancel",
      danger: false,
      resolve
    });
  });
  setConfirmRequest(null);
  if (outcome !== "confirm") return;
  window.location.href = discordHostedBotApi.startOAuthUrl();
}

async function handleRegisterGuild() {
  if (!pickedGuild) return;
  setError("");
  try {
    await discordHostedBotApi.register(pickedGuild.id, window.location.origin);
    setConnectedGuildName(pickedGuild.name);
    setOwnedGuilds(null);
    setPickedGuild(null);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}
```

In the `phase === "enabled"` render block, replace the existing hosted-path hint text:

```tsx
{choice === "hosted" && <p>Put the token into <a href="https://mentat-link.darkdante.org/setup">mentat-link's setup form</a>.</p>}
```

with:

```tsx
{choice === "hosted" && !ownedGuilds && !connectedGuildName && (
  <button onClick={() => { void handleConnectToHostedBot(); }}>Connect to hosted bot</button>
)}
{choice === "hosted" && connectedGuildName && <p>Connected to hosted bot for {connectedGuildName}.</p>}
{choice === "hosted" && ownedGuilds && (
  <div>
    <p>Which server is this for?</p>
    <ul>
      {ownedGuilds.map((guild) => (
        <li key={guild.id}>
          <button onClick={() => setPickedGuild(guild)} aria-pressed={pickedGuild?.id === guild.id}>{guild.name}</button>
        </li>
      ))}
    </ul>
    {pickedGuild && <button onClick={() => { void handleRegisterGuild(); }}>Register</button>}
  </div>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd console/web && npx vitest run src/features/settings/DiscordBotSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite and typecheck**

Run: `cd console/web && npx vitest run && npx tsc --noEmit`
Expected: 0 failures, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add console/web/src/features/settings/DiscordBotSection.tsx console/web/src/features/settings/DiscordBotSection.test.tsx
git commit -m "feat(settings): add Connect to hosted bot UI (OAuth flow, guild picker, persisted Connected status)"
```

---

### Task 9: Core-side documentation

**Files:**
- Modify: `docs/integrations/discord-control-bot/setup-guide.md`
- Modify: `.env.example`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the new redirect URI to `.env.example`**

Find the existing `DISCORD_OAUTH_REDIRECT_URI` line in `.env.example` and add immediately after it:

```
# Second redirect URI, required only if using the hosted mentat bot's
# in-console "Connect to hosted bot" registration flow. Must be
# registered as an additional redirect URI on the SAME Discord
# application as DISCORD_OAUTH_REDIRECT_URI above -- no new Discord app
# needed, just a second registered URI on the existing one.
DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI=
```

- [ ] **Step 2: Update the setup guide**

In `docs/integrations/discord-control-bot/setup-guide.md`, add a new section near the top: "Connecting to the hosted bot (recommended)" — describe the one-click "Connect to hosted bot" flow, note the one-time `DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI` registration requirement, and note that this replaces the old DM + mentat-link setup-portal flow for new connections (the portal itself remains as a fallback, documented in `mentat`'s own docs).

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md`'s `## Unreleased` section:

```markdown
- **Hosted-bot registration is now done entirely in-console** via Settings → Discord Bot → "Connect to hosted bot" — a Discord OAuth round-trip (no new scope) picks an owned guild and registers it with the hosted mentat bot directly, replacing the previous DM + mentat-link setup-portal flow for new connections. Requires registering a second OAuth redirect URI (`DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI`) on the same Discord application. See `docs/design/hosted-bot-oauth-registration-l1-design-2026-09-09.md` for the full design and its Layer 1 Eight-Hats audit.
```

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/discord-control-bot/setup-guide.md .env.example CHANGELOG.md
git commit -m "docs: document the new hosted-bot Connect flow and its redirect-URI requirement"
```

---

### Task 10: `mentat` — `requireProxySecret` exemption + local pre-validation + rate limiter

**Files:**
- Modify: `mentat/src/setupServer.js`
- Create: `mentat/src/consoleRegistrationRateLimit.js`
- Test: `mentat/test/consoleRegistrationRateLimit.test.js`, `mentat/test/proxyAuth.test.js` (extend if it exists, or create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `recordGlobalConsoleRegistrationAttempt()`, `recordUserConsoleRegistrationAttempt(discordUserId)` — used by Task 11's route handler.

- [ ] **Step 1: Add the `exemptPaths` entry**

In `/root/projects/repos/mentat/src/setupServer.js`, find the line:

```js
  app.use(requireProxySecret({ exemptPaths: ["/api/alerts/relay", "/health"], renderError: errorPage }));
```

and change it to:

```js
  app.use(requireProxySecret({ exemptPaths: ["/api/alerts/relay", "/health", "/api/consoles/register"], renderError: errorPage }));
```

- [ ] **Step 2: Write the failing exemption test**

Create (or extend, if it exists — check with `ls test/proxyAuth.test.js` first) `test/proxyAuth.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { requireProxySecret } from "../src/proxyAuth.js";

function fakeReqRes(path) {
  const req = { path, get: () => "", ip: "127.0.0.1" };
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json() { return this; },
    accepts: () => "json"
  };
  return { req, res, getStatus: () => statusCode };
}

test("requireProxySecret exempts /api/consoles/register when a secret is configured", () => {
  process.env.MENTAT_PROXY_SHARED_SECRET = "a-real-secret-that-is-at-least-32-chars-long";
  const middleware = requireProxySecret({ exemptPaths: ["/api/alerts/relay", "/health", "/api/consoles/register"] });
  const { req, res, getStatus } = fakeReqRes("/api/consoles/register");
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "the exempted path must call next() without requiring the header");
  assert.equal(getStatus(), 200);
  delete process.env.MENTAT_PROXY_SHARED_SECRET;
});

test("requireProxySecret still rejects every OTHER route missing the header (exemption is precisely scoped)", () => {
  process.env.MENTAT_PROXY_SHARED_SECRET = "a-real-secret-that-is-at-least-32-chars-long";
  const middleware = requireProxySecret({ exemptPaths: ["/api/alerts/relay", "/health", "/api/consoles/register"] });
  const { req, res, getStatus } = fakeReqRes("/setup/register");
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(getStatus(), 403);
  delete process.env.MENTAT_PROXY_SHARED_SECRET;
});
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd mentat && node --test test/proxyAuth.test.js`
Expected: FAIL before Step 1's edit (or if run before the edit), PASS after.

- [ ] **Step 4: Write the new rate limiter, modeled exactly on `statsPushRateLimit.js`**

Create `mentat/src/consoleRegistrationRateLimit.js`:

```js
// consoleRegistrationRateLimit.js -- rate limiting for the new
// POST /api/consoles/register endpoint (dune-awakening-selfhost-docker's
// hosted-bot OAuth registration design). Modeled directly on
// statsPushRateLimit.js's own global-then-per-key pattern and its most
// important lesson: the per-key bucket (here, per verified Discord user ID)
// must only ever be touched AFTER the forwarded token has already been
// independently re-verified against Discord -- guildId/userId arrive
// alongside an UNVERIFIED token in the request, so consuming a per-user
// bucket before verification would let anyone claiming any user ID exhaust
// that specific user's quota with zero valid credentials. The global bucket
// has no such key and is the only limit an unauthenticated caller can ever
// affect -- and it is what actually bounds the endpoint's real cost (one
// outbound Discord API call per accepted request), since a garbage token
// still reaches the local shape-validation step (see the route handler)
// before this limiter is even consulted for the per-user bucket.
const PER_USER_MAX_ATTEMPTS = 10;
const PER_USER_WINDOW_MS = 60 * 1000;
const PER_USER_BLOCK_MS = 60 * 1000;

const GLOBAL_MAX_ATTEMPTS = 120;
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_BLOCK_MS = 30 * 1000;

const GLOBAL_KEY = "__global__";

let perUserAttempts = new Map();
let globalAttempts = new Map();
let now = () => Date.now();

let perUserMax = PER_USER_MAX_ATTEMPTS;
let perUserWindow = PER_USER_WINDOW_MS;
let perUserBlock = PER_USER_BLOCK_MS;
let globalMax = GLOBAL_MAX_ATTEMPTS;
let globalWindow = GLOBAL_WINDOW_MS;
let globalBlock = GLOBAL_BLOCK_MS;

export function resetConsoleRegistrationRateLimiterForTests(options = {}) {
  perUserAttempts = new Map();
  globalAttempts = new Map();
  perUserMax = options.perUserMax ?? PER_USER_MAX_ATTEMPTS;
  perUserWindow = options.perUserWindow ?? PER_USER_WINDOW_MS;
  perUserBlock = options.perUserBlock ?? PER_USER_BLOCK_MS;
  globalMax = options.globalMax ?? GLOBAL_MAX_ATTEMPTS;
  globalWindow = options.globalWindow ?? GLOBAL_WINDOW_MS;
  globalBlock = options.globalBlock ?? GLOBAL_BLOCK_MS;
  now = options.now ?? (() => Date.now());
}

function activeBucket(map, key, timestamp, windowMs) {
  const current = map.get(key);
  if (!current) return null;
  if (current.blockedUntil && current.blockedUntil > timestamp) return current;
  if (current.firstAttemptAt + windowMs <= timestamp) {
    map.delete(key);
    return null;
  }
  return current;
}

function checkBucket(map, key, timestamp, windowMs) {
  const current = activeBucket(map, key, timestamp, windowMs);
  if (current?.blockedUntil && current.blockedUntil > timestamp) {
    return { allowed: false, retryAfterSeconds: Math.ceil((current.blockedUntil - timestamp) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function recordBucket(map, key, timestamp, windowMs, maxAttempts, blockMs) {
  const current = activeBucket(map, key, timestamp, windowMs);
  if (current?.blockedUntil && current.blockedUntil > timestamp) {
    return checkBucket(map, key, timestamp, windowMs);
  }
  const next = !current || current.firstAttemptAt + windowMs <= timestamp
    ? { count: 1, firstAttemptAt: timestamp, blockedUntil: 0 }
    : { ...current, count: current.count + 1 };
  if (next.count >= maxAttempts) next.blockedUntil = timestamp + blockMs;
  map.set(key, next);
  return checkBucket(map, key, timestamp, windowMs);
}

// recordGlobalConsoleRegistrationAttempt: call this FIRST, before any local
// validation or Discord call. Bounds total request volume regardless of
// credential validity -- the only limit an unauthenticated caller can ever
// affect.
export function recordGlobalConsoleRegistrationAttempt() {
  const timestamp = now();
  return recordBucket(globalAttempts, GLOBAL_KEY, timestamp, globalWindow, globalMax, globalBlock);
}

// recordUserConsoleRegistrationAttempt: call this ONLY after the forwarded
// token has already been independently verified against Discord for this
// exact userId. Never call it before verification succeeds.
export function recordUserConsoleRegistrationAttempt(discordUserId) {
  const timestamp = now();
  return recordBucket(perUserAttempts, String(discordUserId || ""), timestamp, perUserWindow, perUserMax, perUserBlock);
}
```

- [ ] **Step 5: Write the failing test, then confirm it passes**

Create `mentat/test/consoleRegistrationRateLimit.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { recordGlobalConsoleRegistrationAttempt, recordUserConsoleRegistrationAttempt, resetConsoleRegistrationRateLimiterForTests } from "../src/consoleRegistrationRateLimit.js";

test("global bucket blocks after its threshold, independent of any user id", () => {
  let clock = 0;
  resetConsoleRegistrationRateLimiterForTests({ globalMax: 3, globalWindow: 10000, globalBlock: 5000, now: () => clock });
  assert.equal(recordGlobalConsoleRegistrationAttempt().allowed, true);
  assert.equal(recordGlobalConsoleRegistrationAttempt().allowed, true);
  assert.equal(recordGlobalConsoleRegistrationAttempt().allowed, false, "the 3rd call reaches maxAttempts=3 and is itself blocked");
});

test("per-user bucket only limits the specific user id it's called for", () => {
  let clock = 0;
  resetConsoleRegistrationRateLimiterForTests({ perUserMax: 2, perUserWindow: 10000, perUserBlock: 5000, now: () => clock });
  recordUserConsoleRegistrationAttempt("111111111111111111");
  assert.equal(recordUserConsoleRegistrationAttempt("111111111111111111").allowed, false, "the 2nd call for the same user reaches maxAttempts=2 and is blocked");
  assert.equal(recordUserConsoleRegistrationAttempt("222222222222222222").allowed, true, "a different user's bucket is unaffected");
});

test("an already-blocked bucket does not have its block silently extended by further calls (mentat#276 regression)", () => {
  let clock = 0;
  resetConsoleRegistrationRateLimiterForTests({ globalMax: 1, globalWindow: 10000, globalBlock: 5000, now: () => clock });
  recordGlobalConsoleRegistrationAttempt();
  const secondCallResult = recordGlobalConsoleRegistrationAttempt();
  clock = 4000;
  const thirdCallResult = recordGlobalConsoleRegistrationAttempt();
  assert.ok(thirdCallResult.retryAfterSeconds <= secondCallResult.retryAfterSeconds, "retryAfterSeconds must count down, not reset, across repeated calls while blocked");
});
```

Run: `cd mentat && node --test test/consoleRegistrationRateLimit.test.js`
Expected: PASS (this module is a copy of an already-correct, already-tested pattern, so no red-then-green cycle is needed beyond confirming the copy is faithful — but still run it to confirm).

- [ ] **Step 6: Commit**

```bash
git add src/setupServer.js src/consoleRegistrationRateLimit.js test/proxyAuth.test.js test/consoleRegistrationRateLimit.test.js
git commit -m "feat(consoles): exempt /api/consoles/register from requireProxySecret; add its rate limiter"
```

---

### Task 11: `mentat` — the `POST /api/consoles/register` route

**Files:**
- Create: `mentat/src/consoleRegistration.js`
- Modify: `mentat/src/setupServer.js`
- Test: `mentat/test/consoleRegistration.test.js`

**Interfaces:**
- Consumes: `recordGlobalConsoleRegistrationAttempt`, `recordUserConsoleRegistrationAttempt` (Task 10); `upsertGuild` (existing, `database.js`).
- Produces: the live route.

- [ ] **Step 1: Write the failing tests**

Create `mentat/test/consoleRegistration.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { verifyAndRegisterConsole } from "../src/consoleRegistration.js";
import { resetConsoleRegistrationRateLimiterForTests } from "../src/consoleRegistrationRateLimit.js";
import { createDatabase, getGuild } from "../src/database.js";

function fakeDb() {
  return createDatabase(":memory:");
}

test("rejects a malformed token/guildId with zero calls to Discord", async () => {
  resetConsoleRegistrationRateLimiterForTests({});
  let discordCalled = false;
  const fetchImpl = async () => { discordCalled = true; return { ok: true, json: async () => ([]) }; };
  const result = await verifyAndRegisterConsole(fakeDb(), { guildId: "not-a-snowflake", discordAccessToken: "x", consoleUrl: "https://example.test", adapterToken: "tok" }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(discordCalled, false, "a malformed guildId must be rejected before any Discord call");
});

test("registers successfully when the forwarded token proves ownership of the submitted guildId", async () => {
  resetConsoleRegistrationRateLimiterForTests({});
  const db = fakeDb();
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "111111111111111111", name: "Real Guild", owner: true }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999" }) };
  };
  const result = await verifyAndRegisterConsole(db, { guildId: "111111111111111111", discordAccessToken: "tok", consoleUrl: "https://example.test", adapterToken: "adaptertoken" }, { fetchImpl });
  assert.equal(result.ok, true);
  const stored = getGuild(db, "111111111111111111");
  assert.equal(stored.status, "active");
  assert.equal(stored.console_url, "https://example.test");
});

test("rejects when the forwarded token proves ownership of a DIFFERENT guild than the one submitted (the single most important negative test)", async () => {
  resetConsoleRegistrationRateLimiterForTests({});
  const db = fakeDb();
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "333333333333333333", name: "A Different Guild I Really Own", owner: true }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999" }) };
  };
  const result = await verifyAndRegisterConsole(db, { guildId: "111111111111111111", discordAccessToken: "tok", consoleUrl: "https://attacker.test", adapterToken: "x" }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(getGuild(db, "111111111111111111"), undefined, "the victim guild must not be registered");
});

test("rejects an expired/invalid token (Discord itself returns non-200)", async () => {
  resetConsoleRegistrationRateLimiterForTests({});
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await verifyAndRegisterConsole(fakeDb(), { guildId: "111111111111111111", discordAccessToken: "expired", consoleUrl: "https://example.test", adapterToken: "x" }, { fetchImpl });
  assert.equal(result.ok, false);
});

test("never logs or persists the forwarded discordAccessToken anywhere", async () => {
  resetConsoleRegistrationRateLimiterForTests({});
  const db = fakeDb();
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "111111111111111111", name: "G", owner: true }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999" }) };
  };
  const secretToken = "super-secret-live-discord-token-value";
  await verifyAndRegisterConsole(db, { guildId: "111111111111111111", discordAccessToken: secretToken, consoleUrl: "https://example.test", adapterToken: "x" }, { fetchImpl });
  const stored = getGuild(db, "111111111111111111");
  assert.ok(!JSON.stringify(stored).includes(secretToken));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mentat && node --test test/consoleRegistration.test.js`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `mentat/src/consoleRegistration.js`:

```js
// consoleRegistration.js -- POST /api/consoles/register's business logic.
// The single load-bearing security property: never trust the submitted
// guildId/ownership claim without independently re-verifying it against
// Discord using the FORWARDED token, exactly the way this same file's
// setupServer.js sibling (resolveGuildName()) already calls Discord's API
// with a caller-supplied token -- this function is that same pattern,
// applied to the actual authorization decision, not just a display name.
import { upsertGuild } from "./database.js";
import { recordGlobalConsoleRegistrationAttempt, recordUserConsoleRegistrationAttempt } from "./consoleRegistrationRateLimit.js";
import { logInfo, logError } from "./logger.js";

const SNOWFLAKE_PATTERN = /^\d{17,19}$/;

async function fetchOwnedGuildIds(accessToken, fetchImpl) {
  const response = await fetchImpl("https://discord.com/api/v10/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  const guilds = await response.json();
  if (!Array.isArray(guilds)) return null;
  return guilds.filter((g) => g && g.owner === true).map((g) => String(g.id));
}

async function fetchDiscordUserId(accessToken, fetchImpl) {
  const response = await fetchImpl("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return String(user?.id || "") || null;
}

// verifyAndRegisterConsole: the full accept/reject/register decision.
// Returns { ok: true } on success, { ok: false, reason } on any rejection
// -- the route handler translates `reason` into the specific, deliberately-
// vague-on-the-ambiguous-case error copy the design calls for; this
// function itself never needs to know about HTTP status codes.
export async function verifyAndRegisterConsole(db, { guildId, discordAccessToken, consoleUrl, adapterToken }, { fetchImpl = globalThis.fetch } = {}) {
  const globalCheck = recordGlobalConsoleRegistrationAttempt();
  if (!globalCheck.allowed) return { ok: false, reason: "rate_limited" };

  // Cheap, local validation BEFORE any outbound Discord call -- the DoS
  // bound the design's own §3.3 requires. A garbage token/guildId never
  // reaches Discord's API at all.
  if (typeof discordAccessToken !== "string" || discordAccessToken.length === 0 || discordAccessToken.length > 1000) {
    return { ok: false, reason: "malformed_token" };
  }
  if (typeof guildId !== "string" || !SNOWFLAKE_PATTERN.test(guildId)) {
    return { ok: false, reason: "malformed_guild_id" };
  }
  if (typeof consoleUrl !== "string" || consoleUrl.length === 0) {
    return { ok: false, reason: "missing_console_url" };
  }
  if (typeof adapterToken !== "string" || adapterToken.length === 0) {
    return { ok: false, reason: "missing_adapter_token" };
  }

  let ownedGuildIds;
  let discordUserId;
  try {
    [ownedGuildIds, discordUserId] = await Promise.all([
      fetchOwnedGuildIds(discordAccessToken, fetchImpl),
      fetchDiscordUserId(discordAccessToken, fetchImpl)
    ]);
  } catch (err) {
    logError("console_registration.discord_unreachable", err, { guildId });
    return { ok: false, reason: "discord_unreachable" };
  }
  if (!ownedGuildIds || !discordUserId) {
    return { ok: false, reason: "invalid_token" };
  }

  // Per-user bucket is only ever touched AFTER the token has already
  // proven a real Discord identity -- see consoleRegistrationRateLimit.js's
  // own module comment for why touching it any earlier would be a
  // victim-targetable DoS.
  const userCheck = recordUserConsoleRegistrationAttempt(discordUserId);
  if (!userCheck.allowed) return { ok: false, reason: "rate_limited" };

  // THE load-bearing check: the submitted guildId must be one the token's
  // own owner genuinely owns -- never trust the request body's claim alone.
  if (!ownedGuildIds.includes(guildId)) {
    logInfo("console_registration.guild_ownership_mismatch", { guildId, discordUserId });
    return { ok: false, reason: "guild_not_owned" };
  }

  upsertGuild(db, {
    guildId,
    guildName: "Unknown", // resolved lazily elsewhere if needed; not worth a second Discord call here since fetchOwnedGuildIds already confirms membership+ownership
    consoleUrl,
    adapterToken,
    status: "active"
  });
  logInfo("console_registration.registered", { guildId, discordUserId });
  // discordAccessToken deliberately goes out of scope here, never
  // persisted, never logged -- the last reference to it in this function
  // was the two fetch calls above.
  return { ok: true };
}
```

(Note: `guildName: "Unknown"` is a deliberate, honest simplification — `fetchOwnedGuildIds` above only fetches guild IDs, not names, since names aren't needed for the ownership check. If a real guild name is wanted in the DB, extend `fetchOwnedGuildIds` to also return `{id, name}` pairs and look up the matching one — this is a one-line addition if the implementer wants it, but is not required by the design and is left here as `"Unknown"` rather than adding an unrequested feature, matching this org's own YAGNI discipline.)

- [ ] **Step 4: Wire the route into `setupServer.js`**

In `mentat/src/setupServer.js`, add near the top:

```js
import { verifyAndRegisterConsole } from "./consoleRegistration.js";
```

Add the route (after the `requireProxySecret` middleware, anywhere among the other `app.post`/`app.get` route registrations):

```js
  app.post("/api/consoles/register", async (req, res) => {
    try {
      const { guildId, discordAccessToken, consoleUrl, adapterToken } = req.body;
      const result = await verifyAndRegisterConsole(db, { guildId, discordAccessToken, consoleUrl, adapterToken });
      if (!result.ok) {
        const status = result.reason === "rate_limited" ? 429 : result.reason === "discord_unreachable" ? 502 : 403;
        return res.status(status).json({ error: "Could not verify you own that Discord server -- please try connecting again." });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      logError("console_registration.route_error", err, {});
      return res.status(500).json({ error: "Registration failed unexpectedly." });
    }
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mentat && node --test test/consoleRegistration.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd mentat && node --test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/consoleRegistration.js src/setupServer.js test/consoleRegistration.test.js
git commit -m "feat(consoles): add POST /api/consoles/register with independent Discord re-verification"
```

---

### Task 12: `mentat` — remove the DM-on-invite trigger; add the in-guild "not registered" reply

**Files:**
- Modify: `mentat/src/onboarding.js`
- Modify: `mentat/src/index.js`
- Test: `mentat/test/onboarding.test.js` (extend existing), `mentat/test/index.test.js` or the real equivalent command-dispatch test file (check what exists first)

**Interfaces:**
- Consumes: `getGuild` (existing, `database.js`).
- Produces: `handleGuildCreate()` removed; a new "not registered" reply path in command dispatch.

- [ ] **Step 1: Confirm nothing else depends on the DM-sending internals before removing them**

Run: `grep -rn "handleGuildCreate\|proclamationHeader\|proclamationSetupSteps\|setupMessageFor\|ownerNoticeFor\|fallbackNoticeFor\|findInviter\|clampGuildName\|clampMessageContent" mentat/src mentat/test --include="*.js"`

Confirm every hit is either inside `onboarding.js` itself or its own test file (`onboarding.test.js`), and the one call site in `index.js` (`Events.GuildCreate` handler). If any OTHER file imports one of these helpers, stop and re-scope this task — do not delete something still in use.

- [ ] **Step 2: Remove the DM trigger**

In `mentat/src/onboarding.js`, delete the `handleGuildCreate` export and every helper function that exists ONLY to support it (per Step 1's confirmation): `clampGuildName`, `clampMessageContent`, `proclamationHeader`, `proclamationSetupSteps`, `setupMessageFor`, `ownerNoticeFor`, `fallbackNoticeFor`, `findInviter`, and the `SETUP_URL` constant if nothing else in the file uses it. Leave `handleGuildDelete` and anything unrelated to the DM flow untouched.

In `mentat/src/index.js`, find the `Events.GuildCreate` handler that calls `handleGuildCreate(bot, guild, db)` and remove that call (and the now-unused `handleGuildCreate` import). If the `Events.GuildCreate` handler did nothing else, remove the whole handler registration; if it did other work too, keep the handler and only remove the `handleGuildCreate` call within it.

- [ ] **Step 3: Add the in-guild "not registered" reply**

Find `mentat/src/index.js`'s command-dispatch entry point (the `Events.InteractionCreate` handler, around line 260 per this plan's own research) and the point where a command's guild is resolved before being routed to `AdapterClient`. Add a check immediately before that routing: if `getGuild(db, interaction.guildId)?.status !== "active"`, reply to the interaction with:

```
This server isn't connected to a console yet. A server admin should go to their Dune Docker console's Settings → Discord Bot page and click "Connect to hosted bot."
```

and return without calling into `AdapterClient` at all (this is a real behavior change from today's silent fallback-to-default-config in `AdapterClient._resolveConfig()` — confirmed during this plan's research that the current fallback produces no clear signal at all for an unregistered guild; this check replaces that with an explicit, actionable reply). The exact interaction-reply mechanism (`interaction.reply(...)` vs. an existing wrapper function this codebase already uses for command responses) should match whatever pattern the surrounding code in this same handler already uses — read the ~50 lines around the dispatch point directly before writing this, since this plan's own research did not capture that exact reply-sending convention.

- [ ] **Step 4: Write the regression tests**

Add to `mentat/test/onboarding.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

test("handleGuildCreate is no longer exported (DM-on-invite trigger removed)", async () => {
  const onboarding = await import("../src/onboarding.js");
  assert.equal(onboarding.handleGuildCreate, undefined);
});
```

Add a test (in whatever file already covers `Events.GuildCreate`/`Events.InteractionCreate` dispatch, or a new one) confirming: a command interaction for a guild with no `guilds` row (or `status !== "active"`) gets the "not connected" reply and never reaches `AdapterClient`; a command interaction for an `active` guild proceeds normally (unchanged behavior).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mentat && node --test`
Expected: 0 failures across the whole suite (this task touches shared dispatch code — run everything, not just the new test file).

- [ ] **Step 6: Commit**

```bash
git add src/onboarding.js src/index.js test/onboarding.test.js
git commit -m "feat(onboarding): remove DM-on-invite trigger; reply in-guild when a command is run in an unregistered server"
```

---

### Task 13: `mentat` documentation fixes (9 files)

**Files:**
- Modify: `mentat/docs/setup-portal-guide.md`, `mentat/docs/admin-guide.md`, `mentat/docs/multi-tenant-design.md`, `mentat/docs/configuration.md`, `mentat/docs/discord-setup.md`, `mentat/docs/faq.md`, `mentat/docs/quick-start-guide.md`, `mentat/docs/installation-guide.md`, `mentat/README.md`, `mentat/USAGE.md`

Per the design doc's §7 (as expanded by its own supplementary documentation-consistency pass), every one of these files currently describes the DM-on-invite flow and/or the manual `openssl`-based token setup as the primary or only path. For each file:

- [ ] **Step 1: `docs/setup-portal-guide.md`** — add a top-level note: the primary path is now Core's Settings → Discord Bot → "Connect to hosted bot"; this guide's manual walkthrough is the fallback. Remove or clearly mark stale the "Option B: Generate a new token from the portal" section (already independently stale per `mentat#194`'s revert, regardless of this design).

- [ ] **Step 2: `docs/admin-guide.md`** — same "generate a fresh one from the portal" correction (lines ~63/67).

- [ ] **Step 3: `docs/multi-tenant-design.md`** (lines ~142-225) — update the "Onboarding Flow"/"Phase 4: DM Onboarding" section to describe the new in-console flow as primary, the DM as removed, and `/setup` as a fallback.

- [ ] **Step 4: `docs/configuration.md`** (line ~382) — change "RBAC is configured per-guild via the web portal or DM onboarding" to reference the new in-console flow.

- [ ] **Step 5: `docs/discord-setup.md`** (lines ~87-111) — resolve the "why `permissions=128`" rationale: confirm whether `findInviter()`'s audit-log lookup is still relevant for any purpose after Task 12 removes its only caller (`handleGuildCreate`) — if `findInviter()` was deleted in Task 12 (it should have been, per Step 1's confirmation there), this permission requirement may no longer be needed at all; verify against the real, current bot's permission requirements and update this doc to either drop the `permissions=128` requirement or explain its real, remaining justification.

- [ ] **Step 6: `docs/faq.md`** (lines ~274-277) — remove the "Generate a new token via the setup portal's Generate button" instruction (stale for two reasons: the button was reverted per `mentat#194`, and token generation now happens in Core's console) and replace with a pointer to Settings → Discord Bot → Enable/Regenerate Token.

- [ ] **Step 7: `docs/quick-start-guide.md`** (lines ~36-46, ~143-158) and **Step 8: `docs/installation-guide.md`** (lines ~53-59, ~242, ~372) — update "open the setup portal" onboarding/troubleshooting steps to describe the new in-console flow as primary.

- [ ] **Step 9: `README.md`** (lines ~42-56, ~121) — update the "Quick Start / For Server Owners" flow and the "primary path" pointer.

- [ ] **Step 10: `USAGE.md`** (lines ~67-101) — update "Setup options" to remove "DM Onboarding" as a listed option (it no longer exists) and describe the new in-console flow.

- [ ] **Step 11: Commit**

```bash
git add docs/setup-portal-guide.md docs/admin-guide.md docs/multi-tenant-design.md docs/configuration.md docs/discord-setup.md docs/faq.md docs/quick-start-guide.md docs/installation-guide.md README.md USAGE.md
git commit -m "docs: update all setup-flow documentation for the new in-console hosted-bot registration"
```

---

### Task 14: `mentat` — CHANGELOG entry

**Files:**
- Modify: `mentat/CHANGELOG.md`

- [ ] **Step 1: Add the entry**

```markdown
- **Removed the DM-on-invite onboarding trigger.** New guild registrations for the hosted bot now happen via an in-console action in Core's Settings → Discord Bot section, which independently re-verifies guild ownership before registering. `/setup`/`POST /setup/register` remain as a documented fallback. Commands run in an unregistered guild now get an explicit, actionable in-guild reply instead of silently falling back to a default config. See `dune-awakening-selfhost-docker`'s `docs/design/hosted-bot-oauth-registration-l1-design-2026-09-09.md` for the full design and its Layer 1 Eight-Hats audit.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for the new hosted-bot registration flow"
```

---

### Task 15: `mentat-link` documentation fixes

**Files:**
- Modify: `mentat-link/index.html` (2 sections)
- Modify: `mentat-link/docs/setup/index.html`
- Modify: `mentat-link/docs/index.html`
- Modify: `mentat-link/privacy.html`

- [ ] **Step 1: `index.html`'s FAQ `#setup` section** — replace the manual `openssl`/`chmod`/paste token-rotation instructions with a pointer to Core's Settings → Discord Bot → Enable/Regenerate Token.

- [ ] **Step 2: `index.html`'s "How Sahir Venn Works" homepage explainer** (`class="how-it-works"`, step 2) — replace "Sign in with Discord on the setup portal, then enter your console URL and adapter token" with copy describing the new in-console "Connect to hosted bot" flow.

- [ ] **Step 3: `docs/setup/index.html`** — replace the full manual `openssl rand -hex 32 > ...` / `chmod 600` / `echo ... >` walkthrough with the new primary path, keeping the manual steps below as a clearly-labeled fallback (not deleted).

- [ ] **Step 4: `docs/index.html`** — update "Open the Setup Portal Guide to connect your Discord server to Sahir Venn" to point at the new primary path first.

- [ ] **Step 5: `privacy.html`** (§3.4 "Discord OAuth Setup Data", §8 "Correction") — this is the compliance-priority item. Update the data-handling description to account for the fact that Core's console now also transiently handles the same class of live Discord OAuth token, server-side, for the duration of one request during registration — not just mentat's own bot process. Be precise and accurate about what Core does and doesn't retain (per the design's §2/§4: used once, never persisted, never logged).

- [ ] **Step 6: Commit**

```bash
git add index.html docs/setup/index.html docs/index.html privacy.html
git commit -m "docs: update setup-flow copy for the new in-console hosted-bot registration"
```

---

### Task 16: Full-suite verification across all 3 repos

**Files:** none (verification only)

- [ ] **Step 1: `dune-awakening-selfhost-docker` backend**

Run: `cd console/api && node --test`
Expected: 0 failures.

- [ ] **Step 2: `dune-awakening-selfhost-docker` frontend**

Run: `cd console/web && npx vitest run && npx tsc --noEmit`
Expected: 0 failures, 0 type errors.

- [ ] **Step 3: `mentat`**

Run: `cd mentat && node --test`
Expected: 0 failures.

- [ ] **Step 4: Manual end-to-end verification (Requirement 0 — cannot be automated)**

Per the design's §5: a real Core console with real Discord OAuth configured, a real Discord application with `DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI` registered, a real guild the test operator owns — confirm the full round trip: click "Connect to hosted bot" → Discord consent → guild picker renders → pick the guild → confirm → "Connected to hosted bot for `<guild name>`" → the bot subsequently authenticates against the registered console for a real command in that guild.

- [ ] **Step 5: Push and open the 3 PRs**

```bash
# dune-awakening-selfhost-docker
git push -u origin <branch-name>
gh pr create --repo Project-Arrakis/dune-awakening-selfhost-docker --title "feat: hosted-bot console-initiated OAuth registration (Core side)" --body "Implements docs/design/hosted-bot-oauth-registration-l1-design-2026-09-09.md. Closes #739." --draft

# mentat
git push -u origin <branch-name>
gh pr create --repo Project-Arrakis/mentat --title "feat: hosted-bot console registration endpoint; remove DM onboarding" --body "Implements dune-awakening-selfhost-docker's design doc. Closes mentat#316." --draft

# mentat-link
git push -u origin <branch-name>
gh pr create --repo Project-Arrakis/mentat-link --title "docs: update setup-flow copy for in-console hosted-bot registration" --body "Closes mentat-link#159." --draft
```

Per Requirement 20, a Layer 3 integration audit (`/code-review ultra` or a local `/code-review high` pass, per this org's own judgment call on scale, across all 3 PRs together given they're one feature) is required before any of these leave draft — do not mark any ready until that's run and its CRITICAL/HIGH findings are resolved, matching the process already followed for this feature's Layer 1 design.
