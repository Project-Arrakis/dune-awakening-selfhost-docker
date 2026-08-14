# Multi-Server Guide: Staging and Upstream Pull Request Workflow

**Status:** Current | **Last Updated:** August 2026

This document is the maintainer/contributor companion to [`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md). It records the staging-PR workflow and the exact GitHub CLI (`gh`) procedure for submitting the multi-server guide and configuration helper upstream without carrying unrelated fork history.

The authoritative upstream repository is:

```text
Red-Blink/dune-awakening-selfhost-docker
```

The staging fork used while preparing this documentation is:

```text
yacketrj/dune-awakening-selfhost-docker
```

The staging PR is:

```text
https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/262
```

---

# Why a Clean Upstream Branch Is Required

The staging fork has diverged from upstream `Red-Blink/main`. In particular, the documentation index can differ between the fork and upstream.

Do **not** simply retarget the staging PR to `Red-Blink/main` if the branch contains unrelated fork history or stale upstream files.

The safe procedure is:

1. fetch current upstream;
2. create a new branch directly from `upstream/main`;
3. bring in only the multi-server deliverables;
4. add the documentation-index entry against the current upstream index;
5. validate the resulting diff;
6. push that clean branch to the contributor fork;
7. open a draft PR against `Red-Blink/main`.

This keeps the upstream contribution narrowly scoped and reviewable.

---

# Deliverables to Submit Upstream

The intended upstream change set consists of:

```text
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md
runtime/scripts/multi-server-config.py
docs/README.md                     # index entry only
```

If this companion workflow is also desired upstream, include:

```text
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

No existing runtime defaults should be changed merely to publish the documentation/helper.

---

# Prerequisites

Confirm Git and GitHub CLI are available:

```bash
git --version
gh --version
```

Confirm GitHub CLI authentication:

```bash
gh auth status
```

Confirm repository remotes:

```bash
git remote -v
```

A typical contributor setup is:

```text
origin    https://github.com/yacketrj/dune-awakening-selfhost-docker.git
upstream  https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

If `upstream` does not exist:

```bash
git remote add upstream https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

Verify:

```bash
git remote -v
```

---

# Step 1 - Fetch Both Repositories

```bash
git fetch --prune upstream
git fetch --prune origin
```

Inspect current refs:

```bash
git log --oneline -5 upstream/main
git log --oneline -5 origin/agent/multi-server-single-public-ip-guide
```

Do not proceed if `upstream/main` cannot be resolved.

---

# Step 2 - Create a Clean Branch from Current Upstream Main

Choose a descriptive branch name:

```bash
git switch -c docs/multi-server-single-public-ip upstream/main
```

Confirm the branch is based on upstream:

```bash
git status
git merge-base --is-ancestor upstream/main HEAD && echo "based on upstream/main"
```

At this point the branch should contain **zero** staging-fork changes.

---

# Step 3 - Bring in Only the Final Guide and Helper

Copy only the reviewed files from the staging branch:

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py
```

If including this maintainer workflow upstream as well:

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Inspect status:

```bash
git status --short
```

Expected new files should be visible; unrelated application/runtime files should not be modified.

---

# Step 4 - Add the Documentation Index Entry Against Current Upstream

Do **not** copy the staging fork's entire `docs/README.md` over current upstream.

Instead, edit the current upstream file and add the guide under the Runtime section.

A safe scripted insertion is:

```bash
python3 - <<'PY'
from pathlib import Path

path = Path("docs/README.md")
text = path.read_text(encoding="utf-8")

entry = (
    "- [MULTI-SERVER-SINGLE-PUBLIC-IP.md]"
    "(runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. "
    "Executive overview and detailed SOP for running multiple isolated "
    "Dune battlegroups behind one public IPv4, including per-instance port "
    "profiles, NAT/hairpin requirements, UserEngine configuration, validation, "
    "rollback, and the multi-server configuration helper.\n"
)

if entry in text:
    raise SystemExit("Index entry already exists; review manually.")

marker = (
    "- [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md) — "
    "Current. End-to-end validation procedure for the metrics stack "
    "(`runtime/metrics`).\n"
)

if marker not in text:
    raise SystemExit(
        "Runtime index insertion marker was not found. "
        "Upstream docs/README.md has changed; edit it manually instead of guessing."
    )

path.write_text(text.replace(marker, marker + entry), encoding="utf-8")
PY
```

If the marker has changed upstream, stop and edit the Runtime section manually. Do not force a brittle text replacement.

---

# Step 5 - Validate the Helper

Syntax-check the helper:

```bash
python3 -m py_compile runtime/scripts/multi-server-config.py
```

Generate a three-instance plan:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

At the validated baseline, instance 2 should resolve to:

```text
Player/game UDP base   7877
IGW UDP base           7988
PostgreSQL              16432
RMQ Admin               33573
RMQ Game                32982
RMQ Game HTTP           32983
Text Router              5159
Director                12717
Admin Web                8090
```

If the helper refuses to derive current defaults, treat that as evidence that upstream source layout changed. Review and update the helper rather than bypassing its guard.

---

# Step 6 - Validate the Documentation Diff

Run:

```bash
git diff --check
```

Review the exact change set:

```bash
git diff -- \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md \
  runtime/scripts/multi-server-config.py
```

Confirm no unrelated files are changed:

```bash
git status --short
```

A narrow upstream submission should contain only the intended documentation/helper files.

---

# Step 7 - Commit the Clean Upstream-Based Change

Stage only the intended files:

```bash
git add \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py
```

If including this workflow:

```bash
git add docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Verify staged content:

```bash
git diff --cached --stat
git diff --cached --check
```

Commit:

```bash
git commit -m "docs/runtime: add multi-server SOP and configuration helper"
```

---

# Step 8 - Push the Clean Branch to the Contributor Fork

```bash
git push -u origin docs/multi-server-single-public-ip
```

Verify the remote branch:

```bash
git ls-remote --heads origin docs/multi-server-single-public-ip
```

---

# Step 9 - Create the Upstream Draft PR with `gh`

Create a PR body file:

```bash
cat >/tmp/multi-server-upstream-pr.md <<'EOF'
## Summary

Adds a source-driven operator/community guide and configuration helper for
running multiple independent Dune: Awakening battlegroups on one physical host
while sharing one public IPv4 address.

### Documentation

Adds `docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md` with:

- executive architecture summary;
- detailed step-by-step deployment SOP;
- one-VM-per-battlegroup isolation model;
- complete per-instance service-port profiles;
- public IPv4/NAT architecture;
- `SERVER_IP` vs `SERVER_BIND_IP` behavior;
- UserEngine `Port` and `IGWPort` configuration;
- RMQ Game and RMQ Game HTTP endpoint handling;
- NAT reflection/hairpin validation;
- firewall and port-forwarding examples;
- Web Console security guidance;
- configuration validation and packet-capture procedures;
- rollback and upgrade procedures;
- troubleshooting matrix;
- source-of-truth references.

### Automation helper

Adds `runtime/scripts/multi-server-config.py`.

The helper provides:

- `plan` — derive current source-backed defaults and calculate instance profiles;
- `apply` — back up and configure one VM's `.env` and UserEngine network values;
- `verify` — compare saved state against the expected instance profile.

The helper derives defaults from the checked-out repository and intentionally
refuses to silently apply a historical profile if the source patterns it relies
on have changed.

### Important implementation detail

Current runtime behavior makes UserEngine `Port` and `IGWPort` authoritative for
the player/game and IGW bases. The helper therefore uses
`runtime/scripts/usersettings.py engine-set` rather than relying on `.env`
`CLIENT_PORT_BASE` / `IGW_PORT_BASE` alone.

For instance 2 the standard profile is:

```text
Port / player base      7877
IGWPort                 7988
PostgreSQL             16432
RMQ Admin              33573
RMQ Game               32982
RMQ Game HTTP          32983
Text Router             5159
Director               12717
Admin Web               8090
```

The helper changes `IGWPort` before `Port` to avoid the transient invalid overlap
that would occur if instance 2's player range were moved while IGW remained on
the stock `7888` base.

### Public endpoint model

For each instance, the guide assigns unique public mappings for:

- RMQ Game TCP;
- RMQ Game HTTP TCP;
- player/game UDP pool;
- Admin Web TCP when intentionally exposed.

Internal/control-plane services also receive distinct per-instance configured
ports, but the guide explicitly does not recommend publishing PostgreSQL, RMQ
Admin, Text Router, Director, or observability backends directly to the WAN.

### Validation

- helper syntax checked;
- source-backed default derivation exercised;
- VM1/VM2/VM3 profile generation validated;
- VM2 exact expected values validated;
- `.env` update path exercised;
- authoritative UserEngine update path exercised;
- backup/verify behavior exercised;
- public NAT rule rendering exercised.

No existing Dune runtime default is changed merely by merging this PR. The helper
acts only when explicitly invoked.
EOF
```

Open the upstream draft PR:

```bash
gh pr create \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --base main \
  --head yacketrj:docs/multi-server-single-public-ip \
  --draft \
  --title "docs/runtime: add multi-server SOP and configuration helper" \
  --body-file /tmp/multi-server-upstream-pr.md
```

Record the returned PR URL.

---

# Step 10 - Confirm the Upstream PR Contains Only Intended Changes

After creation:

```bash
gh pr view \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --web
```

CLI inspection:

```bash
gh pr view \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --json number,title,state,isDraft,baseRefName,headRefName,files
```

Review the changed-file list carefully. It should not contain unrelated fork-only commits or stale copies of upstream files.

---

# Optional: Compare the Clean Branch to Upstream Before Opening the PR

```bash
git diff --stat upstream/main...HEAD
git log --oneline upstream/main..HEAD
```

The log should normally show only the intentionally created documentation/helper commit(s).

---

# Failure / Recovery Guidance

## Wrong base branch

If the clean branch was accidentally created from fork `main` rather than `upstream/main`, delete/recreate it instead of trying to manually remove unrelated history:

```bash
git switch main
git branch -D docs/multi-server-single-public-ip
git switch -c docs/multi-server-single-public-ip upstream/main
```

Then repeat the selective file checkout.

## Stale upstream

If upstream advances before PR creation:

```bash
git fetch upstream
git rebase upstream/main
```

Resolve only genuine conflicts. Re-run helper/document validation after rebasing.

## `docs/README.md` conflict

Prefer rebuilding the one-line index change against the current upstream file instead of carrying a stale fork copy through conflict resolution.

---

# Maintainer Checklist

Before opening or marking the upstream PR ready for review, confirm:

- [ ] branch is based on current `Red-Blink/main`;
- [ ] no unrelated fork history is present;
- [ ] full SOP file is present;
- [ ] `multi-server-config.py` is present;
- [ ] docs index entry is present and based on current upstream index;
- [ ] Python syntax check passes;
- [ ] `plan --instances 3` succeeds against current source;
- [ ] VM2 profile still matches the documented policy or documentation/helper were updated together;
- [ ] `git diff --check` passes;
- [ ] no secrets, `.env`, generated credentials, or private configuration were added;
- [ ] PR is opened as draft first;
- [ ] changed-file list contains only intended contribution files.
