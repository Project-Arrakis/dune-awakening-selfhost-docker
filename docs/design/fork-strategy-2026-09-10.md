# Fork Strategy Decision — Product, Staging Ground, or Addon Overlay?

**Status:** Draft — Layer 1 decision document. Research complete; Eight-Hats audit partially complete (see §7 — genuine independent multi-agent dispatch was not available in the environment this was produced in; treat the audit coverage here as provisional, not a substitute for a real dispatched pass).
**Tracking issue:** `dune-awakening-selfhost-docker#495`
**Research spec:** `~/projects/meta/Project-Arrakis/archive/sessions/2026-08-25-fork-strategy-research-prompt.md`
**Author's note:** Every figure below was re-gathered fresh on 2026-09-10 (not trusted from #495/#664/the research prompt, all of which are 2+ weeks and hundreds of commits stale) via content verification, not commit-message or SHA-ancestry pattern matching — both proven unreliable in this specific repo (history rewrite invalidated SHA ancestry; upstream's own PR numbers collide with ours in commit messages).

## 1. The decision this document makes

**Is `Project-Arrakis/dune-awakening-selfhost-docker` a product, a staging ground, or an addon overlay?**

**Recommendation: a hybrid, closest to Path C, with a narrow, explicit Path-A carve-out for authentication.** Ship the auth-and-identity surface (Tier 1/Tier 3 console auth, RBAC, the Discord OAuth work — including this session's own hosted-bot wizard) as a small, actively-synced fork delta that tracks upstream continuously and is upstreamed PR-by-PR on its own timeline (already in progress, see §4). Treat everything else divergent (Live Map, inventory panels, metrics — the bulk of the 750-file divergence) as a standing addon-extraction backlog: evaluated and migrated file-by-file into `dune-ops-observability-addon`/new addons over time, not as a single re-architecture project. Full reasoning and the case against this in §5-§6.

## 2. Evidence (re-gathered 2026-09-10)

### 2.1 Divergence

```
$ git rev-list --left-right --count origin/main...upstream/main
1367  1161
$ git diff --stat upstream/main...origin/main | tail -1
750 files changed, 208597 insertions(+), 6299 deletions(-)
```

`git` reports "multiple merge bases" resolving this diff — a sign this repo's history has real structural complexity (consistent with the 2026-08-24 Co-Authored-By history rewrite noted in the research prompt as already invalidating SHA-ancestry-based audits). Any merge attempt should expect this, not be surprised by it.

**Where it lives** (unchanged conclusion from the 2026-08-25 research, re-verified):

```
239 console/api
236 console/web
 96 runtime/scripts
 17 runtime/tests
 15 docs/console
 13 runtime/metrics
```

475/750 files (63%) is still the console — the same concentration found three weeks ago, confirming this isn't a transient artifact of one large PR.

### 2.2 Versions and what actually runs where

```
$ git show origin/main:VERSION   # v1.3.95 (fork main — stale, not bumped in the reconciliations since)
$ git show upstream/main:VERSION # v1.4.12
$ ssh dune-prod 'cat .../VERSION' # v1.4.12
```

**dune-prod runs upstream directly, not the fork — re-confirmed structurally**, not just by version string: `console/api/src/auth/{totp,recoveryCodes,secondFactorStore}.js` (fork-only Tier 3 files) are absent on the prod checkout. This is unchanged from the 2026-08-25 finding and remains, per that research, the operator's confirmed intended architecture — not drift to fix.

**dune-dev**, separately (found investigating the immediate trigger for this document — an operator report that Settings→API Keys is missing there): is not tracking either `main` — it's on whatever feature branch was last checked out for live testing (currently `feat/739-hosted-bot-oauth-registration-core`, itself branched from a point in fork history before API Keys existed upstream, and fork `main` itself still lacks it — `apiKeys.js`/`apiKeyScopes.js`, added upstream in PR #198, are absent from `origin/main` today). This is a *third* distinct deployment reality (prod=upstream, dev=ad hoc feature branch, fork main=neither), which §6 addresses directly since it's the practical problem that surfaced this whole question again.

### 2.3 Release posture (unchanged)

```
Fork releases: 0        Upstream releases: 30
Fork tags: 112 (up from 103 three weeks ago -- tags keep accruing, releases still don't)
Release workflow: none in .github/workflows/
self-update.sh DEFAULT_SELF_UPDATE_REPO: "Red-Blink/dune-awakening-selfhost-docker" (unchanged)
```

Nothing has changed here in three weeks. There is still no product to install from this fork, and the self-update default still points every fresh install at upstream.

### 2.4 Q2 — upstream absorption throughput (re-derived, more precisely than the original research)

Real data, not assumed: merged PRs from this org's own account (`yacketrj`) into `Red-Blink/dune-awakening-selfhost-docker`, 2026-07-08 through 2026-08-21 (6.5 weeks):

- **28 merged PRs**, ~30,300 lines of net additions actually landed upstream in that window (~4,700 lines/week sustained absorption rate).
- Several large PRs were **closed unmerged**, but not rejected — e.g. #199/#200 (~11,800 lines each, Tier 1+3 combined) were closed in favor of splitting into separate stacked drafts (`tier3-upstream`, now open as #201/#202) so each half could be reviewed independently. This is **process friction, not a dead end** — there is an active, in-progress upstream contribution channel for exactly the auth work this document recommends keeping as a fork-Path-A carve-out (see §4).
- At ~4,700 lines/week absorption against a **208,597-line total divergence**, and assuming (optimistically) divergence stopped growing entirely, full absorption would take **~44 weeks (~10 months)** through this channel alone. Divergence will not stop growing while this fork keeps building features, so pure Path B (rely on upstream absorption alone) is not viable for the *bulk* of the divergence — consistent with the original research's Q2 concern, now with a real number behind it instead of an assumption.

### 2.5 Issue #491 (lost merged PRs) — re-verified, status: partially resolved by drift, core risk still open

Content-verified against current `main`:

```
$ git show origin/main:console/api/Dockerfile | grep FROM
FROM node:24-trixie-slim AS web-build
FROM node:24-trixie-slim
$ git merge-base --is-ancestor e3b02fc73fc434be131c6de9db8fac356cc2074f origin/main
NOT an ancestor
```

**#98's specific payload (`node:20-bookworm` → `node:26-bookworm`) is still genuinely absent from `main`** — confirmed independently, not just trusted from the issue. But the base image has moved twice since (`node:20-bookworm` → `node:24-trixie-slim` via unrelated commit `c248780e`, itself already noted in #491), so **that specific lost change is now moot** — re-applying it would be reapplying a superseded value. **The underlying risk #491 exists to flag is NOT moot**: the loss mechanism (a reconciliation silently dropping a merged commit's content, with green status everywhere) is real, demonstrated, and has no detection guard today. #491 remains open and correctly so — this document does not resolve it, and treats it as a hard prerequisite (§4) for any large-scale sync, per the original research's own constraint.

### 2.6 Addon precedent for the Path-C portion of the recommendation

`dune-ops-observability-addon` already installs into the console (real, shipped, currently running) and already has a mature 5-gate release process with an evidence-bundle discipline (`ops-observability/roadmap/release-standard.md`). This is real, working infrastructure Path C's recommended portions can build on directly, not something to invent from scratch. This document does not attempt the full file-by-file classification of which of the 475 divergent console files are addon-extractable (Q1 from the research prompt) — that remains a genuinely large, separate research effort the original 2026-08-25 prompt scoped correctly as "the single highest-value unknown." What's confirmed here is narrower and sufficient for a decision: the *mechanism* Path C depends on already exists and works for at least one real subsystem (observability/metrics), and the strong prior from the original research — **Tier 3 auth is irreducibly core** (modifies the login route, session model, and policy engine at their roots) — is independently corroborated by §2.4's evidence that auth work is already being pursued through the *upstream PR* channel, not proposed as an addon by anyone, including the team that built it.

## 3. Answering Q1-Q5

**Q1 (what fraction of the 475 console files could become addons):** Not fully answered here — genuinely out of scope for a single-session decision document, per the original research's own framing. What's answered: the mechanism exists and works (§2.6), and auth is confirmed not addon-shaped by the team's own behavior (pursuing it upstream, not as an addon). Recommend this remains a tracked, separate research/implementation program (§6), not a blocker for deciding the overall strategy now.

**Q2 (could upstream absorb a meaningful share):** Real data now exists (§2.4) — yes, for auth specifically, at a real and continuing pace; no, for the bulk of the 208k-line divergence, which the absorption rate cannot plausibly clear while the fork keeps producing new work.

**Q3 (Path A's per-release cost):** Unchanged from the original research's framing — the addon repo's 5-gate process is the honest reference cost, plus CVE-response ownership for a published image. This document does not re-cost it since the recommendation is not full Path A; the cost only matters if a future decision expands the fork-Path-A carve-out beyond auth.

**Q4 (is prod migration to the fork feasible):** Moot under this recommendation — prod stays on upstream (confirmed intentional, §2.2), and nothing here proposes migrating it. This removes Q4's entire premise (migrating prod backwards from v1.4.12 to a v1.3.95-based fork) rather than answering it.

**Q5 (cost of not deciding), the one paragraph an operator can act on without reading the rest:**

> The status quo already has a running, non-zero cost: dune-dev currently runs an arbitrary feature branch instead of any coherent baseline (missing Settings→API Keys and everything else upstream has shipped since that branch point), fork `main` has drifted to 1161 commits behind upstream with no release mechanism to ever ship its own 208,597 lines of divergence to anyone, and issue #491's lost-merged-PR risk means every past "we synced/merged that" claim in this repo's history is unverified until content-checked. Every week this goes undecided, the divergence grows (this session alone widened it from 1131 to 1161 commits behind in about 48 hours), upstream absorption gets relatively less able to ever catch up (§2.4), and new work (like this session's own hosted-bot wizard) keeps landing on branches cut from an increasingly stale baseline — silently reproducing the exact "why is a feature missing" report that triggered this document. Deciding now, even imperfectly, is cheaper than deciding never.

## 4. Prerequisites — apply to every path, unchanged from the original research

- **#359** (dune-dev/prod are untracked copies, not git checkouts) — still OPEN. Directly explains why dune-dev could silently be running an unrelated feature branch with nobody noticing until a feature-gap report — this is not hypothetical, it is what happened this week.
- **#493** (self-update silently ignores `DUNE_SELF_UPDATE_REPO`) — still OPEN.
- **#491** (lost merged PRs, loss mechanism undetected) — still OPEN, still blocks any large-scale sync per the original research's own hard constraint. §2.5 above narrows this to "the mechanism is the real risk, not necessarily every historical instance," but does not close it — a detection guard (the issue's own §"Scope of work" item 4, e.g. via `mentat-observatory`'s existing cross-repo monitoring pattern) should exist before the next large reconciliation, not be discovered missing again after one.

## 5. The case against this recommendation

Stated honestly, per the research prompt's own requirement:

- **A hybrid is harder to execute cleanly than a clean A/B/C** — it requires sustained discipline to keep the auth carve-out narrow (not let unrelated console features quietly ride along on "it touches the login page too" reasoning) and to actually run the addon-extraction program rather than let it become an unstaffed backlog line item, the same fate that appears to have befallen the original Q1 research itself (never started, per §0 below).
- **It does not resolve the 208,597-line divergence** — it only stops it from being the org's stated *strategy*. The lines still exist, still need maintenance, and the recommendation explicitly defers deciding what happens to most of them.
- **Pure Path B** (aggressive upstream-only, delete what doesn't fit) is cheaper and more honest about what this team's actual throughput can sustain (§2.4's real numbers), at the cost of writing off real, working features (Live Map, inventory panels) that operators may already depend on if any fork-main-based installs exist in the wild.
- **Pure Path A** (fork as product) remains the most internally consistent with "234 files of real, audited, shipped console work" — the counter-argument is entirely operational (no release train, no CVE process, no promotion path) rather than about the work's merit, and all three of those gaps are fixable engineering work, not fundamental blockers, if the org is willing to own them.

## 6. Phased plan (Path A/C-hybrid implementation, once approved — not started here)

1. Resolve prerequisites (#359, #493, #491's detection guard) — blocking for everything below.
2. Perform the 1161-commit `upstream/main` merge into fork `main` (never reset/force-push, per this repo's own standing rule), verified against #491's new detection guard so a repeat loss is caught immediately, not months later.
3. Re-point dune-dev's live-testing convention at post-merge fork `main` (or a documented, intentional feature-branch convention) rather than leaving it on whatever branch was last touched — closes the immediate trigger for this document.
4. Continue the already-in-progress upstream auth PRs (#201/#202 and successors) on their own timeline — no new process needed, this channel already works.
5. Scope and staff the Q1 addon-extraction research as its own tracked initiative (not blocking steps 1-4) — assign it a real session/owner rather than leaving it as an unclaimed backlog item, which is what happened to the original 2026-08-25 research prompt.

## 7. Layer 1 audit — coverage note and provisional self-check

**This document was produced by a single agent worker without access to dispatch genuinely independent Agent-tool subagents in the environment it ran in.** Per this org's own Requirement 20 ("treat 'I reasoned through all eight hats myself in one pass' as equivalent to using only one hat"), **the review below does not satisfy the org's own bar for a real Eight-Hats audit** and should not be treated as such. It is a provisional, single-pass self-check across the three lenses the research prompt weighted most heavily (GRC, Architect, Security), offered so this document isn't submitted with zero adversarial review, not as a substitute for the real dispatch this decision deserves given its scope.

- **GRC (heaviest weight per the research prompt):** the biggest gap this document itself has is exactly what it flags in §5 — no committed owner or timeline for the Q1 addon-extraction research, which is the same failure mode that left the *original* research prompt unstarted for two weeks. Recommend the approval step that follows this document explicitly assign that, not leave it implicit. Audit-trail requirement (Requirement 20) is only partially met — see the STRIDE table below and the explicit disclosure above.
- **Architect (heaviest weight per the research prompt):** the hybrid's real structural risk is scope creep at the auth/non-auth boundary — nothing in this document defines a mechanical test for "is this file part of the auth carve-out," which a future session will need before the recommendation is actionable day-to-day. Flagged as a real gap, not resolved here.
- **Security (weighted for Path A's CVE-ownership question, less relevant since this recommendation is not full Path A):** the narrow auth carve-out under this recommendation still means the fork continues to independently build and (eventually) deploy security-sensitive code (Tier 1/3 auth, Discord OAuth, the hosted-bot wizard this whole session built) ahead of or independent of upstream's own review — the existing Requirement 20 Layer 1/2/3 discipline this org already applies to that specific work (e.g., the hosted-bot wizard's own two-round audit this session) is the correct existing control for that risk, not something this document needs to add on top.

### STRIDE table

| Category | Finding | Severity | Status |
|---|---|---|---|
| Repudiation | #491's loss mechanism means past "merged/synced" claims are unverified | HIGH (carried over from #491, not new) | Open, prerequisite for §4 |
| Elevation of Privilege | N/A — this document is a strategy decision, not a code change with a privilege surface | — | — |
| Spoofing / Tampering / Information Disclosure / Denial of Service | N/A this layer | — | No STRIDE-mappable findings from a strategy-level document |

**No new GitHub issues filed from this audit pass** — the real findings it surfaces (§5's execution risks) are process/ownership gaps in the recommendation itself, appropriately tracked as follow-up items in §6's phased plan rather than as standalone bug-style issues, and the genuinely open technical prerequisites (#359, #491, #493) already have issues.

**Recommendation for whoever reviews this:** commission a real, dispatched Eight-Hats pass on this specific document before treating the decision as final, the same discipline this session already applied twice to the hosted-bot wizard design — a strategy decision this consequential deserves at least the same rigor as a single feature's design doc.
