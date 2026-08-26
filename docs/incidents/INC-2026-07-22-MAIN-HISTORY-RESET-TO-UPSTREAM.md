# Incident Case Study: `main`'s History Was Replaced by Upstream Twice, Silently Discarding Merged Work

**Incident ID:** INC-2026-07-22-001

**Dates:** Event A — between 2026-06-30T23:28:38Z and 2026-07-03T02:46:44Z. Event B — between 2026-07-21T04:20:10Z and 2026-07-22T19:31:27Z.

**Discovered:** 2026-08-25, while root-causing #489 (console `python3` regression). Root-caused 2026-08-26.

**Status:** Root-caused. Remediation in progress — `.github/dependabot.yml` restored (#496); re-application of other lost content tracked separately under #491.

**Scope:** Repository history only. **No operator deployment was affected and no player-facing system was involved.** This fork is not what `dune-prod` runs, and the lost content was configuration, documentation, and console-side features — nothing in the game-server runtime path. Requirement 0 is not engaged. The damage is to this repository's own change record and to two dependency controls.

## Summary

On two separate occasions, this fork's `main` branch had its history **replaced** by upstream (`Red-Blink`) history rather than merged with it. Both times, every fork-side commit that had not yet been re-applied elsewhere vanished from `main`'s ancestry — including merged PRs, merged Dependabot bumps, and configuration files.

This is precisely the operation the repository's operating rules already forbid:

> **Never `git reset --hard` a fork's `main` to sync with upstream.** Use `git merge --ff-only` instead — identical result when genuinely behind, but fails loudly instead of silently discarding local-only history the moment it exists.

The rule existed before these events. Neither event was written up at the time, so no incident record existed until this one, and the losses went unnoticed for **five weeks** — surfacing only by coincidence, when an unrelated investigation into a broken console panel asked whether Dependabot had introduced a bad base image.

## Impact

**Confirmed, still outstanding today:**

- **Dependabot version updates have been switched off since 2026-07-22.** `.github/dependabot.yml` (added by #93 on 2026-07-19) was destroyed by Event B. Only the org-wide *security*-update channel has run since. Tracked as #496.
- **Console world-partition controls are gone** (#50): the `worldPartitionsCheck` / `worldPartitionsRepair` runner mappings, the `/api/database/world-partitions` API routes, and the DatabasePanel UI. The underlying shell scripts survive; the console surface that drove them does not.
- **Seven documentation files are gone** (#76): `docs/ISSUE-74-CLEAN-REPRO.md`, `docs/ADMIN-POWERSHELL.md`, four `docs/WINDOWS-WSL-*.md` files, and `.github/pull_request_template.md`.
- **Three dependency bumps were reverted** and never re-applied: `typescript` 6.0.3 → today `^5.7.3` (#58), `@types/react` 19.2.17 → today `^19.2.16` (#60), `ubuntu` 26.04 → today `FROM ubuntu:24.04` (#97).
- **`compliance/README.md` is gone** (#93) — the SOC 2 control documentation index.
- **`.github/workflows/security-gates.yml` and `.gitleaksignore` are gone** (#55). The *capability* was independently rebuilt on 2026-08-21 (#457's `ci.yml` scanners, `.gitleaks.toml`), so this one is closed in effect if not in file.

**Confirmed contributing cost:** #98 (`node:20-bookworm` → `node:26-bookworm`) was lost in Event B. Had it survived, the console image would have stayed on the full Debian variant that ships `python3-minimal`, and #489 — the dead console Home panel caused by a later slim-base bump silently dropping `python3` — would very likely never have occurred.

**Not affected:** no game-server container, no database, no player session, no operator deployment. `dune-prod` tracks upstream releases and does not run this fork's code at all.

## Root cause

`main` was reset onto upstream's history instead of merged with it. Twice.

### Event A — 2026-06-30 / 2026-07-03

Dependency versions moved *backwards* across a window in which no PR was merged, so the change arrived by direct push:

| Probe (merge commit) | Merged | `typescript` | `@types/react` |
|---|---|---|---|
| #86 `81fb947c` | 2026-06-30T23:28:38Z | `^6.0.3` | `^19.2.17` |
| #87 `97faa59d` | 2026-07-03T02:46:44Z | `^5.7.3` | `^19.2.16` |

Walking #87's first-parent chain shows what it was built on:

```
97faa59d  2026-07-03  Ron Yacketta  Add OPS health aggregate bridge actions (#87)
5163bd83  2026-07-02  Red-Blink     Release v1.3.41
fe2626ea  2026-07-02  Red-Blink     Paginate database table previews
bb632373  2026-07-02  Red-Blink     Stop party grouping warnings on solo story maps
39a917a3  2026-07-02  Red-Blink     Clarify character transfer default policy
```

#87 was merged directly onto pure upstream history. #80, #81, #85, #86 and the June Dependabot bumps are absent from that ancestry.

### Event B — 2026-07-21 / 2026-07-22

| Probe (merge commit) | Merged | `.github/dependabot.yml` | `compliance/README.md` | `ROADMAP.md` |
|---|---|---|---|---|
| #94 `691f06a5` | 2026-07-21T04:15:20Z | 1098 B | 1286 B | 5258 B |
| #95 `b1ce6e8f` | 2026-07-21T04:20:10Z | 1098 B | — | — |
| #103 `d9055f52` | 2026-07-22T19:31:27Z | **404** | **404** | **404** |

#103's first parent is `e188c875b691`, confirmed an upstream commit:

```
$ git merge-base --is-ancestor e188c875b691 upstream/main   # -> true
e188c875  2026-07-21  RedBlink  Merge pull request #98 from yacketrj/feat/specialization-tab
9030d051  2026-07-21  RedBlink  Merge pull request #96 from drkshrk/feat/UI-Alignment
52d28d26  2026-07-20  Red-Blink Release v1.3.61
```

(Note that upstream's own `#98` and `#96` are unrelated to this fork's PRs of the same numbers — a collision that makes PR-number matching useless as an audit method here.)

### Corroborating signature

For every lost path, `main`'s current history contains **zero** commits:

```
$ git log --oneline origin/main -- .github/dependabot.yml   ; # 0 commits
$ git log --oneline origin/main -- compliance/README.md     ; # 0 commits
$ git log --oneline origin/main -- ROADMAP.md               ; # 0 commits
$ git log --oneline origin/main -- .gitleaksignore          ; # 0 commits
```

This is the distinguishing evidence. A file that was *deleted* leaves a delete commit in its path history. Zero commits means the path was never in this ancestry at all — the history was replaced, not edited.

## Why it went undetected for five weeks

1. **A reset produces no failure.** CI passes, `main` is green, and nothing reports that content is missing. This is the same failure class as #457 (a `security-checks` job reporting success while its scanners never ran).
2. **GitHub still shows the PRs as merged.** The merge is a fact about a moment in time; it says nothing about whether the content survived.
3. **Both events were followed by real fork work**, so `main` looked healthy and active. Much of the lost work was re-applied incidentally by later PRs, which masked the losses that were not.
4. **The obvious audit method is broken here.** `git merge-base --is-ancestor <mergeCommit> origin/main` reports 112 of 117 merged PRs as missing — an artifact of the 2026-08-24 Co-Authored-By history rewrite, which changed every SHA while GitHub kept the pre-rewrite ones. Anyone running that check would have dismissed the result as noise, which is what happened on the first pass of this audit.

## What worked as an audit method

Querying **file presence at each PR's own merge commit** through the GitHub API:

```
gh api "repos/<owner>/<repo>/contents/<path>?ref=<mergeCommitSha>"
```

Those objects survive both the history rewrite and the resets, so they are the only reliable record of what `main` actually contained at a given moment. Bisecting over merge commits by date located both events to within hours.

Methods that produced confidently wrong answers, documented so they are not repeated: merge-commit ancestry (rewrite artifact), PR-number matching in commit messages (collides with upstream's numbering), and per-file diff sampling (code legitimately moves between files — only tree-wide content search is sound).

## Remediation

**Done:**

- Full audit of all 19 candidate PRs completed and recorded on #491.
- `.github/dependabot.yml` restored verbatim from `691f06a5` (this PR, #496).
- This incident record created.

**Outstanding:**

- Re-apply the remaining lost content on its own merits, not as blind reverts — #50 (console feature), #76 (docs), #97 / #58 / #60 (bumps). #98 is moot; the base image has since moved to `node:24-trixie-slim`.
- Decide whether `dependabot.yml` should gain `npm` entries for `/console/api` and `/console/web`. The recovered file covers only `docker` and `github-actions`, leaving the repo's largest dependency surface with no scheduled sweep (#496).
- **Build the detection guard.** `sentinel-ops-monitor` should content-verify recently-merged PRs rather than trusting merge status — the same lesson its PR #35 applied to a green job whose scanner never ran. Both events here would have been caught within an hour by a check asking "is this merged PR's content still present on `main`?"

## Lessons

1. **A merged PR is not evidence that its content is deployed.** Until this audit, every "we merged that fix" claim in this repository predating 2026-07-22 was unverified. Content verification is the only sound check.
2. **The rule was already written and was still violated.** The prohibition on `git reset --hard` against a fork's `main` predates both events. A rule with no mechanical enforcement is a preference; the guard above is what turns it into a control.
3. **Write the incident up when it happens.** Neither event was recorded, so the second one had no chance of being recognised as a recurrence. CC7.2 requires the record; its absence here directly cost five weeks of undetected control failure.
4. **A history rewrite invalidates SHA-based audit tooling permanently.** Any future forensic work on this repository must use content, not ancestry.
