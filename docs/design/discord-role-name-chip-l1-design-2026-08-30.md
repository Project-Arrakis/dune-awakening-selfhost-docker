# Show the operator's actual Discord role name in the signed-in chip — L1 Design

**Status:** Revision 2 (post Eight Hats Layer 1 audit — see §6)
**Tracking issue:** dune-awakening-selfhost-docker#573 (PROMPT 3, F3)
**Base:** `tier1-upstream` @ `e0ccbfca` (verified current at design time — `tier4-totp-upstream`,
this feature-set's originally-documented baseline, has diverged and is stale; see
`archive/sessions/2026-08-30-layered-auth-upstream-extraction-and-feature-set-continuation.md`)

## 1. Problem

The signed-in chip (`App.tsx`, `sidebar-user-tier`) shows the console access **tier**
(owner/admin/moderator/player) — not the Discord role that actually granted it. An
install that names its Admin role "Heavy bats" and Moderators "Silencers" wants to see
those names, since the console only ever matches on role **ID**, never persisting a
name anywhere.

Two structural reasons this isn't automatic today (verified against the real code):
- The setup wizard has operators paste role **IDs** into
  `DISCORD_CONSOLE_{ADMIN,MODERATOR,PLAYER}_ROLE_IDS` (comma-separated, **multiple
  IDs per tier allowed** — this is load-bearing for §3's UI design, see the
  Architect/UI findings in §6).
- A pure-OAuth (no-bot) install cannot fetch guild role names at login: Discord's
  `GET /guilds/{id}/roles` needs a bot token this path doesn't have, and the member
  object only carries role IDs.

## 2. Verified current surfaces (read directly, not assumed)

- **`resolveRoleTier(memberRoleIds, roleTiers)`** (`roleTiers.js:32-40`) iterates
  `ROLE_MAPPABLE_TIERS` (fixed order: `admin, moderator, player`,
  `roleTiers.js:13`) and returns the first matching tier string only.
- **`resolveOAuthTier(identity)`** (`oauth.js:259-305`) has three exit paths:
  `handoff.enabled` (bot is authoritative), a guild-owner path (`tier: "owner"`,
  never role-derived), and the role/bootstrap path (calls `resolveRoleTier`
  internally, and sets `source: "roles"` only when the picked tier is genuinely the
  role-derived one — **confirmed by the Architect hat this already distinguishes
  role-derived from bootstrap-allowlist-derived matches via `source`**, load-bearing
  for §3's guard against showing an incidental role's name next to a
  bootstrap-granted tier).
- **`makeSession(...)`** (`auth.js:59-65`) has no `roleName` field; `sessions` is a
  plain in-memory `Map` (`auth.js:3`) — **DBA hat confirmed no schema/migration/
  persistence concern exists anywhere in this design.**
- **`GET /api/auth/me`** (`server.js:1001-1035`) returns `user: {id, username,
  displayName, tier, guildId}`.
- **Chip rendering** (`App.tsx`, `sidebar-user-tier`, ~line 1013):
  `<span className={\`sidebar-user-tier tier-${userInfo.tier}\`}>{userInfo.tier}
  </span>` — CSS class stays tier-keyed, unconditionally, in every version of this
  design.
- **Handoff** (`handoff.js`, full file read): `resolveTier({userId, username})`
  POSTs to the bot's `/resolve-console-tier` and receives `{...payload, signature}`
  where `payload` is `{userId, guildId, tier, ts}`. **Architect hat correction to an
  earlier revision of this doc:** `validatePayload` does **not** "construct" a
  canonical object — it returns the exact same object reference it was handed
  (`return { ok: true, payload }`). The real pass-through point is `const {
  signature, ...payload } = body` in `resolveTier` (`handoff.js:148`): object rest
  preserves the bot's original key order, so `JSON.stringify(payloadCheck.payload)`
  on the console reproduces byte-identical JSON to what the bot signed, *because
  it's the same object*, not because of any canonicalization step. This is a
  stronger guarantee than a "canonical constructor" framing implies, but also more
  fragile to a well-intentioned refactor that rebuilds the object — **explicit
  constraint for implementation: never rebuild the validated payload object; always
  pass the same reference through to `verifyPayload`.**
- **`services/envFile.js`'s `quoteEnv`** (lines 33-36) JSON.stringify-escapes any
  `.env` value containing characters outside `[A-Za-z0-9_.:-]`. **`server.js`'s
  `parseEnvLine`** (lines 6361-6372) only strips a single outer quote pair — it does
  **not** unescape internal `\"`. Reproduced directly (Architect + DBA hats,
  independently): round-tripping a JSON object literal through
  `quoteEnv`→`parseEnvLine`→`JSON.parse` throws. Every existing `.env` value this
  project writes (comma-separated snowflakes, URLs, flags) happens to contain no
  embedded quote characters, so this latent bug in the shared quoting scheme has
  never been triggered before. **This is the design's one CRITICAL finding — see
  §3(a) for the fix.**

## 3. Design (revision 2 — incorporates all CRITICAL/HIGH Eight Hats findings)

### (a) Universal fallback — operator-typed labels, persisted as a name map

Storage: `DISCORD_CONSOLE_ROLE_NAMES`, a **base64url-encoded** JSON `{roleId: name}`
map (not per-tier — role IDs are already the join key). **Base64url-encoding before
writing is a direct fix for the CRITICAL `quoteEnv`/`parseEnvLine` round-trip bug**:
base64url's alphabet (`A-Za-z0-9_-`) is a strict subset of the charset `quoteEnv`
already leaves unescaped, so the value passes through both the writer and the
existing single-quote-stripping reader completely unchanged — no new escaping edge
case introduced into the shared `.env` quoting scheme at all.

Read-time (config load) and write-time (`validateOAuthWriteConfigKey`,
`server.js:6150`) both decode/parse defensively:
- Write-time: reject with an HTTP 400 (matching the existing role-ID-list
  validation pattern in the same function) unless: the raw value decodes as valid
  base64url; the decoded bytes parse as JSON; the parsed value is a plain object
  (`Array.isArray` and `typeof !== "object"` both rejected); every key matches the
  existing snowflake regex (`DISCORD_SNOWFLAKE_RE` or equivalent, matching
  `USER_SNOWFLAKE_RE` in `handoff.js`); every value is a string ≤ 100 chars; total
  entry count ≤ 50; and no key is `__proto__`, `constructor`, or `prototype`
  (defense in depth — parse into `Object.create(null)` or a `Map`, never assign
  directly onto a plain `{}` literal from untrusted keys).
- Read-time (config load, e.g. `config.js`): the same decode+parse wrapped in
  try/catch, **failing safe to `{}` on any error**, matching this codebase's own
  existing precedent for on-disk JSON (`config.js:184-185`) — a malformed value
  (however it got there — hand-edited `.env`, a future bug) must degrade to "no
  names configured," never crash console boot. A boot-time warning is logged (not
  fatal), matching the `misconfigured`/`missing` pattern `createHandoff` already
  uses for its own optional-config validation.

**UI (revised — per the UI/UX hat's HIGH finding on the original one-label-per-tier
proposal):** because a single tier field already accepts multiple comma-separated
role IDs, a friendly-label field placed once *per tier* cannot express "role A is
Heavy Bats, role B is also Admin-mapped but is called something else." The
corrected UI parses whichever role IDs are currently entered across all three tier
fields (deduped) and renders one label input per **role ID**, not per tier field —
grouped under a single "Name your Discord roles (optional)" section below the three
ID fields, each row showing the role ID and a text input for its label, with
placeholder text ("e.g. Heavy Bats") and a shared help line explaining the fallback
behavior (shows the tier name if left blank). This section only renders once at
least one role ID has been entered (nothing to name otherwise). Precedent: this
already matches this panel's own "renders once upstream state exists" pattern used
elsewhere for role-conflict warnings.

**Bot-auto-fill precedence signal (UI/UX hat MEDIUM finding).** **Correction
(post-implementation code review, PR #651): this was NOT actually implemented,
despite this section's original text below claiming it was "addressed" —
found by an independent `/code-review high` pass, not caught before merge.
Deferred, tracked as issue #653**, with the justification that it needs a new
backend `handoffEnabled` config flag the frontend doesn't currently have
access to, not just a frontend tweak — real but non-blocking for this PR,
since it's a UX-clarity gap (a typed label silently has no effect) for a
narrow operator population, not a correctness or security issue. The
original (unshipped) intent, preserved here for #653 to implement: when
handoff is enabled (bot supplies `roleName`, see §3(b)), the per-role label
inputs would be rendered **disabled** with helper text "Provided
automatically by the bot" — so an operator on that path is never left
wondering why their typed label had no visible effect. When handoff is
not enabled, inputs are editable as normal.

### (b) Auto-fill from the bot on the handoff path — `roleName` sent UNSIGNED

**Revised from revision 1 per two independently-raised HIGH findings (Network hat:
version-skew DoS; Security Architect hat: malformed-field DoS) that share one root
cause and one fix.** Revision 1 proposed adding `roleName` *inside* the HMAC-signed
payload. Both hats independently found the same real problem from different
angles:
- Network hat: because the signature covers the *entire* serialized payload, an
  operator who upgrades the bot (now signing 5 fields) before the console (still
  expecting 4) breaks signature verification for **every** handoff login, not just
  the new field — a plausible, non-attacker-triggered availability regression on a
  public fork whose bot and console are independently versioned and deployed.
- Security Architect hat: coupling a purely cosmetic field's validation to
  `validatePayload`'s all-or-nothing pass/fail gate means a malformed (not
  malicious — just buggy) `roleName` from an otherwise-correct bot response denies
  the tier claim entirely, when only the display label was ever wrong.

**Fix: `roleName` is not part of the signed payload at all.** It travels as a
sibling, **unsigned** top-level field in the same JSON response body:
`{...signedPayload, signature, roleName}` — `signedPayload` is unchanged
(`{userId, guildId, tier, ts}`), `signature` continues to cover only
`JSON.stringify(signedPayload)` exactly as today, and `roleName` sits outside both.
This is the correct trust model, not a shortcut: §2 and the Security Architect
hat's Q4 both already established that `roleName` is **never** an authorization
input — only `tier` (still fully HMAC-verified, still `VALID_TIERS`-gated) decides
session privilege. A field with zero authorization weight has no reason to
participate in an integrity check whose only job is protecting `tier` from
tampering; making it unsigned means:
- A version-skewed bot/console pair keeps working for its actual security-critical
  job (tier verification) unconditionally — `roleName` simply doesn't arrive until
  both sides are upgraded, exactly the same graceful-degradation the design already
  wants, achieved structurally instead of by careful optional-field handling inside
  a security-critical validator.
- A malformed `roleName` (wrong type, too long) is validated **independently**. If
  it fails validation, only `roleName` is dropped (`undefined`, chip falls back to
  the tier string) — the resolved `tier` itself is completely unaffected, because
  it was never on the same validation path to begin with.
- `handoff.js`'s own stated fail-closed philosophy for `tier` ("No unsigned claim
  may ever produce a tiered session") is **preserved exactly** — the philosophy
  applies to the field that has authorization weight; it was never meant to extend
  to every field in the response body, and this design must not read it that way.

Concretely: `resolveTier()` continues verifying `signedPayload` exactly as today
(zero changes to `validatePayload`/`verifyPayload`/`signPayload`), then separately
reads `body.roleName`: valid only if `typeof body.roleName === "string" &&
body.roleName.length <= 100`, otherwise treated as absent. The resolved return
value gains `roleName` (`undefined` when absent or invalid) alongside the existing
`{tier, reason}`.

### Resolver change

`resolveOAuthTier` returns `{tier, source, reason, roleName?}`:
- Handoff path: `roleName` = whatever the bot sent and passed the independent
  length/type check above (or undefined).
- Owner / bootstrap-allowlist path: no `roleName` — **explicit guard: only attach a
  role-map lookup when `source === "roles"`**, per the Architect hat's finding that
  a naive implementation could otherwise show an incidental Player-mapped role's
  name next to a bootstrap-granted Admin tier.
- Role-derived path (`source === "roles"`): `resolveRoleTier` is extended via an
  **internal helper** (`resolveRoleTierDetailed` or similar) that returns `{tier,
  roleId}`; the existing exported `resolveRoleTier(memberRoleIds, roleTiers)`
  becomes a one-line wrapper over it (`return detailed.tier`), so **every existing
  caller and test is a zero-diff no-op** — this is the Architect hat's explicit
  correction to revision 1's "sibling function vs. signature change, TBD" framing,
  which was optimizing the wrong axis (diff size of the new caller) instead of
  preserving the established, single-implementation pattern. `roleTiers.js`'s fixed
  iteration order (`admin, moderator, player`) already guarantees a member holding
  both an Admin- and Moderator-mapped role resolves to the Admin role's ID, with no
  new logic needed — this closes revision 1's own open question (§4 there) as
  **resolved, not deferred**. If a member holds two *different* role IDs both
  mapped to the *same* tier, whichever ID appears first in that tier's
  comma-separated config wins (first-configured-wins) — a documented, deterministic
  tie-break, not a bug, since Discord provides no natural priority between two
  same-tier roles.

### Threading

`handleOAuthCallback`'s `makeSession({..., roleName: resolved.roleName})`;
`makeSession` gains the param, stores it on the session object (`undefined` when
absent). `/api/auth/me` adds `roleName: session.roleName || null`. Chip renders
`{userInfo.roleName || userInfo.tier}` for text, **keeping `tier-${userInfo.tier}`
for the CSS class unconditionally** — an explicit, deliberate choice (not an
accident of `||`) that an empty-string `roleName` (however it arose) falls back to
the tier string exactly like an absent one, covered by a dedicated test (§5).

## 4. Non-goals (unchanged from revision 1)

- Does NOT touch the option-1 "wizard picker via bot" idea from the issue
  (fetching live guild role names via a bot token at setup time) — a materially
  bigger feature than this design's scope.
- Does NOT re-derive or cache role names anywhere except the session — a name
  change in `DISCORD_CONSOLE_ROLE_NAMES` takes effect for the *next* login,
  matching how role-ID mapping changes already work.

## 5. Tests (revision 2 — supersedes revision 1's list per the QA hat's findings)

- Resolver returns the mapped name for a role-derived tier, only when
  `source === "roles"`.
- Missing map entry falls back to the tier string.
- **Corrected from revision 1** (QA hat: the original "handoff wins over local map"
  framing was a tautology, since the handoff path never reads the local map at
  all — there is no shared decision point to test): a dedicated test asserting
  *"on the handoff path, `roleName` comes only from the bot's response and the
  local `DISCORD_CONSOLE_ROLE_NAMES` map is never consulted"* — i.e., proves the
  code paths are structurally separate, not that one "wins" over the other.
- Bootstrap-allowlist-derived owner/admin tier with an incidentally-held,
  role-mapped role never shows that role's name (`source !== "roles"` guard).
- A member holding both an Admin-mapped and a Moderator-mapped role shows the
  Admin role's name (direct `resolveRoleTierDetailed`/resolver unit test).
- Two role IDs mapped to the same tier, both held: first-configured ID's name
  wins, deterministically (regression-proofs the documented tie-break).
- The chip's CSS class stays `tier-{realTier}` regardless of what text renders;
  `roleName: ""` explicitly falls back to the tier string (not a blank chip).
- Handoff signature verification is **completely unaffected** by `roleName`
  presence/absence/validity — a payload signed the existing way (no code changes
  to `signPayload`) verifies identically whether or not the JSON body alongside it
  carries a valid, invalid, or absent `roleName`. Per the QA hat's circularity
  warning, this fixture must be a raw object literal signed directly with
  `signPayload`, never derived from `validatePayload`'s own output, so the test
  can't tautologically pass regardless of a broken implementation.
- A `roleName` that fails the independent length/type check is dropped
  (`undefined`) without affecting `tier` resolution or denying the login.
- `DISCORD_CONSOLE_ROLE_NAMES` write-time validator: rejects non-base64url input,
  non-JSON payloads after decode, non-plain-object JSON, non-snowflake keys,
  overlong values, over-count maps, and `__proto__`/`constructor`/`prototype` keys.
- `DISCORD_CONSOLE_ROLE_NAMES` read-time (config load): a malformed/corrupted
  stored value fails safe to `{}` (no console-boot crash), with a boot-time
  warning logged.
- `/api/auth/me` response includes `roleName` in the exact documented shape.
- `App.tsx` chip component test covering: named role, missing map entry (tier
  fallback), and empty-string `roleName` (tier fallback).

## 6. Eight Hats Layer 1 audit — findings summary

Full independent dispatch, 8 agents, each reading the real code directly (not this
doc's prose) before reporting. Findings below are what changed the design between
revision 1 and revision 2; the STRIDE table follows.

| # | Hat | Severity | Finding | Resolution |
|---|-----|----------|---------|------------|
| 1 | Architect | **CRITICAL** | `DISCORD_CONSOLE_ROLE_NAMES` as a raw JSON blob does not round-trip through `quoteEnv`/`parseEnvLine` (reproduced) | Fixed in revision 2: base64url-encode before writing (§3a) |
| 2 | Network | **HIGH** | Signing `roleName` inside the HMAC payload causes a bot-before-console upgrade to deny ALL handoff logins (STRIDE: DoS) | Fixed in revision 2: `roleName` sent unsigned, outside the HMAC payload (§3b) |
| 3 | Security Architect | **HIGH** | Coupling `roleName` validation to `validatePayload`'s all-or-nothing gate lets a malformed cosmetic field deny a real tier claim (STRIDE: DoS) | Fixed in revision 2: `roleName` validated independently, never affects `tier`/`validatePayload` (§3b) |
| 4 | Security Architect | **HIGH** | Unguarded `JSON.parse` of `DISCORD_CONSOLE_ROLE_NAMES` at config load could crash console boot (STRIDE: DoS) | Fixed in revision 2: try/catch, fail-safe to `{}`, boot warning (§3a) |
| 5 | UI/UX | **HIGH** | One-label-per-tier UI can't express distinct names for multiple role IDs mapped to the same tier (a supported config today) | Fixed in revision 2: one label input per role ID (§3a) |
| 6 | QA | **HIGH** | "Handoff wins over local map" test (revision 1) was a tautology — handoff path never reads the local map | Fixed in revision 2: test corrected to assert path separation (§5) |
| 7 | QA | **HIGH** | `resolveRoleTier` extension left as "TBD, whichever is smaller diff" — untestable as specified; same-tier multi-role-ID ambiguity unaddressed | Fixed in revision 2: internal-helper + zero-diff wrapper pattern specified; tie-break documented (§3) |
| 8 | GRC | **HIGH** (process) | Layer 1 open questions were never filed as issues / posted to #573 | Addressed: this revision-2 doc + STRIDE table posted as an issue comment on #573 per Requirement 20 |
| 9 | Cloud Security | MEDIUM | §4's open validation question should be a hard requirement, not left open | Resolved into concrete spec in §3(a) |
| 10 | Architect | MEDIUM | `validatePayload` doesn't "construct" the canonical object — corrected narrative to prevent a future refactor from breaking pass-through | Corrected in §2 |
| 11 | Architect | MEDIUM | `roleId`→name lookup must only fire when `source === "roles"` | Fixed in revision 2 resolver design (§3) |
| 12 | Security Architect | MEDIUM | Prototype-pollution defense-in-depth for the parsed map | Fixed in revision 2 write-time spec (§3a) |
| 13 | Security Architect | MEDIUM | Write-time validation spec was hand-wavy | Made concrete in §3(a) |
| 14 | GRC | MEDIUM | `docs/console/API-REFERENCE.md` and `docs/rfc-console-auth.md` need updates for the new `roleName` field/env var | **Deferred, tracked**: same-PR doc update required before merge (Requirement 14/19c) — not a design blocker, added to implementation checklist |
| 15 | GRC | MEDIUM | Fork `CHANGELOG.md` follow-up pattern not mentioned | **Deferred, tracked**: same pattern as prior features (`c4b248ad`), added to implementation checklist |
| 16 | UI/UX | MEDIUM | New field's placeholder/help/error copy unspecified | Fixed in revision 2 UI description (§3a) |
| 17 | UI/UX | MEDIUM | "Bot wins" precedence had no operator-facing signal | **Corrected post-merge (code review, PR #651): NOT actually fixed as originally claimed here** — deferred, tracked as issue #653 (§3a) |
| 18 | Network | LOW | Unbounded `roleName` field size | Fixed: 100-char cap enforced at the independent validation boundary (§3b) |
| 19 | Security Architect | LOW | Forward guardrail: if `roleName` is ever logged, apply existing `redactSecrets()`-style control-char sanitization | **Deferred, no current logging path exists** — noted for any future PR that adds logging |
| 20 | Architect | LOW | Tie-break determinism for two same-tier role IDs should be documented | Documented in §3 (first-configured-wins) |
| 21 | GRC | LOW | `docs/integrations/discord-integration/admin-guide.md` could mention the new label option | **Deferred, non-blocking** — noted for the same-PR doc pass |

**Non-findings (explicitly confirmed correct, no action needed):**
- Security Architect: design is correctly scoped display-only, zero authorization
  impact; no `dangerouslySetInnerHTML` anywhere in `console/web/src` (confirmed via
  full-tree grep); React's default text-child escaping covers the chip render.
- Cloud Security: the HMAC shared secret (`DISCORD_BOT_HANDOFF_SECRET`) is
  completely unchanged by this design; `DISCORD_CONSOLE_ROLE_NAMES` has no
  cloud-provider adjacency (confirmed not yet present anywhere in the codebase).
- DBA: no schema/migration/persistence concern anywhere in this design; sessions
  confirmed genuinely in-memory-only.
- Network: no new endpoint, port, or HTTP surface — extends the existing handoff
  call and reuses the existing config-write endpoints unchanged.

### STRIDE summary (Layer 1)

| STRIDE Category | Finding(s) | Severity | Status |
|---|---|---|---|
| Spoofing | None found | N/A | — |
| Tampering | #12 (prototype-pollution defense-in-depth) | MEDIUM | Resolved in design |
| Repudiation | #19 (log sanitization, forward guardrail only — no logging path exists yet) | LOW | Deferred, no current gap |
| Information Disclosure | None found — no cross-user leak, no new secret, no PII | N/A | — |
| Denial of Service | #1 (CRITICAL, env round-trip), #2 (HIGH, signed-payload version skew), #3 (HIGH, validation coupling), #4 (HIGH, config-load crash) | CRITICAL, HIGH, HIGH, HIGH | All four resolved in revision 2 |
| Elevation of Privilege | #12 (dual-mapped with Tampering) | MEDIUM | Resolved in design |

All CRITICAL and HIGH findings are resolved in this revision before implementation
begins, per Requirement 20. MEDIUM findings #14/#15/#21 are tracked as same-PR
documentation follow-ups (not implementation blockers); #19 is a forward guardrail
with no current gap to close.
