# Multi-Server Guide: Staging and Upstream Pull Request Workflow

**Status:** Current | **Last Updated:** August 2026

This is the maintainer/contributor companion to [`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md). It records the clean upstream submission workflow for the multi-server guide and `multi-server-config.py` helper.

The authoritative upstream repository is:

```text
Red-Blink/dune-awakening-selfhost-docker
```

The staging fork is:

```text
yacketrj/dune-awakening-selfhost-docker
```

The staging PR is:

```text
https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/262
```

---

# Critical Port-Policy Requirement

Before submitting upstream, verify that the helper and documentation enforce the same invariant:

> **No managed numeric port or range may overlap any other managed numeric port or range across any generated VM, regardless of protocol.**

The accepted allocation policy uses one uniform per-instance stride:

```text
INSTANCE_PORT_STRIDE = 1000
instance_offset = (instance_number - 1) * 1000
```

Every managed scalar port and every game/IGW range base receives the same offset.

Validated examples:

| Function | VM1 | VM2 | VM3 |
|---|---:|---:|---:|
| Player/Game UDP | `7777-7810` | `8777-8810` | `9777-9810` |
| IGW UDP | `7888-7921` | `8888-8921` | `9888-9921` |
| Admin Web TCP | `8088` | `9088` | `10088` |
| Text Router TCP | `5059` | `6059` | `7059` |
| Director TCP | `11717` | `12717` | `13717` |
| PostgreSQL TCP | `15432` | `16432` | `17432` |
| RMQ Game TCP | `31982` | `32982` | `33982` |
| RMQ Game HTTP TCP | `31983` | `32983` | `33983` |
| RMQ Admin TCP | `32573` | `33573` | `34573` |

The earlier mixed-offset VM2 example using `7877` / `7988` is obsolete because VM2 player ports overlapped VM1 IGW ports.

Do not submit documentation or helper code that reintroduces that allocation.

---

# Why a Clean Upstream Branch Is Required

The staging fork has diverged from `Red-Blink/main`, including documentation-index content.

Do not blindly retarget the staging branch to upstream if that would carry unrelated fork history.

Use this process:

1. fetch upstream and fork;
2. branch directly from current `upstream/main`;
3. copy only the reviewed multi-server deliverables;
4. update the current upstream documentation index in place;
5. validate source-derived defaults;
6. validate global port non-overlap;
7. inspect the exact diff;
8. commit and push the clean branch;
9. open a draft upstream PR with `gh`.

---

# Deliverables

Required:

```text
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md
runtime/scripts/multi-server-config.py
docs/README.md                    # index entry only
```

Optional maintainer companion:

```text
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Merging these files must not change existing game/runtime defaults unless the helper is explicitly invoked by an operator.

---

# Step 1 - Validate Git and GitHub CLI

```bash
git --version
gh --version
gh auth status
git remote -v
```

Expected remote pattern:

```text
origin    https://github.com/yacketrj/dune-awakening-selfhost-docker.git
upstream  https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

If needed:

```bash
git remote add upstream https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

---

# Step 2 - Fetch Current Refs

```bash
git fetch --prune upstream
git fetch --prune origin
```

Inspect:

```bash
git log --oneline -5 upstream/main
git log --oneline -5 origin/agent/multi-server-single-public-ip-guide
```

---

# Step 3 - Branch from Current Upstream Main

```bash
git switch -c docs/multi-server-single-public-ip upstream/main
```

Confirm:

```bash
git merge-base --is-ancestor upstream/main HEAD && \
  echo "branch is based on upstream/main"
```

---

# Step 4 - Bring in Only the Reviewed Deliverables

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py
```

If submitting this companion:

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Do not copy the fork's entire `docs/README.md` over upstream.

---

# Step 5 - Add the Documentation Index Entry

Edit current upstream `docs/README.md` under the Runtime section.

Suggested entry:

```markdown
- [MULTI-SERVER-SINGLE-PUBLIC-IP.md](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. Executive overview and detailed SOP for running multiple isolated Dune battlegroups behind one public IPv4, including globally non-overlapping per-instance port profiles, NAT/hairpin requirements, UserEngine configuration, validation, rollback, and the multi-server configuration helper.
```

A guarded scripted insertion can be used if the expected marker still exists:

```bash
python3 - <<'PY'
from pathlib import Path

path = Path("docs/README.md")
text = path.read_text(encoding="utf-8")

entry = (
    "- [MULTI-SERVER-SINGLE-PUBLIC-IP.md]"
    "(runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. "
    "Executive overview and detailed SOP for running multiple isolated Dune "
    "battlegroups behind one public IPv4, including globally non-overlapping "
    "per-instance port profiles, NAT/hairpin requirements, UserEngine "
    "configuration, validation, rollback, and the multi-server configuration helper.\n"
)

marker = (
    "- [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md) — "
    "Current. End-to-end validation procedure for the metrics stack "
    "(`runtime/metrics`).\n"
)

if entry in text:
    raise SystemExit("Index entry already exists; review manually.")
if marker not in text:
    raise SystemExit("Runtime marker changed upstream; edit docs/README.md manually.")

path.write_text(text.replace(marker, marker + entry), encoding="utf-8")
PY
```

---

# Step 6 - Syntax-Check the Helper

```bash
python3 -m py_compile runtime/scripts/multi-server-config.py
```

---

# Step 7 - Validate the Three-Instance Plan

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

Required output characteristics:

```text
Global instance port stride: +1000
```

VM2 must include:

```text
Player/game UDP : 8777-8810
IGW UDP         : 8888-8921
PostgreSQL TCP  : 16432
RMQ Admin TCP   : 33573
RMQ Game TCP    : 32982
RMQ Game HTTP   : 32983
Text Router TCP : 6059
Director TCP    : 12717
Admin Web TCP   : 9088
```

VM3 must include:

```text
Player/game UDP : 9777-9810
IGW UDP         : 9888-9921
PostgreSQL TCP  : 17432
RMQ Admin TCP   : 34573
RMQ Game TCP    : 33982
RMQ Game HTTP   : 33983
Text Router TCP : 7059
Director TCP    : 13717
Admin Web TCP   : 10088
```

Required success line:

```text
VALIDATION: all generated managed ports are globally non-overlapping.
```

If any collision exists, the helper must exit non-zero.

---

# Step 8 - Validate the Fail-Closed Limit

With the validated source defaults, the uniform `+1000` policy is collision-free through Instance 33 and Instance 34 must fail because a generated port exceeds `65535`.

Optional checks:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 33 >/tmp/dune-plan-33.txt

grep -F 'VALIDATION: all generated managed ports are globally non-overlapping.' \
  /tmp/dune-plan-33.txt
```

Then confirm 34 is rejected:

```bash
if python3 runtime/scripts/multi-server-config.py plan --instances 34; then
  echo "ERROR: instance 34 unexpectedly passed"
  exit 1
else
  echo "PASS: instance 34 rejected"
fi
```

This is not a recommendation to operate 33 battlegroups; it is only an allocator boundary test.

---

# Step 9 - Search for Obsolete Mixed-Offset Values

Before submission, search the deliverables:

```bash
grep -RniE \
  '7877|7910|7988|8021|5159|8090' \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md \
  runtime/scripts/multi-server-config.py || true
```

Any matches must be reviewed.

A historical explanation may intentionally mention obsolete values, but no active configuration table, command, or expected-output block may use them.

---

# Step 10 - Review the Exact Diff

```bash
git diff --check

git status --short

git diff -- \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md \
  runtime/scripts/multi-server-config.py
```

Confirm no unrelated runtime/application changes are present.

---

# Step 11 - Commit

```bash
git add \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py
```

If including this companion:

```bash
git add docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Commit:

```bash
git commit -m "docs/runtime: add collision-free multi-server SOP and helper"
```

---

# Step 12 - Push the Clean Branch

```bash
git push -u origin docs/multi-server-single-public-ip
```

---

# Step 13 - Create the Upstream Draft PR

Create the body:

```bash
cat >/tmp/multi-server-pr.md <<'EOF'
## Summary

Adds a source-driven operator guide and configuration helper for running multiple independent Dune: Awakening battlegroups on isolated VMs behind one shared public IPv4.

### Port-allocation invariant

The guide and helper enforce a strict global rule: no managed numeric port or range may overlap any other managed port or range across any generated VM, regardless of protocol.

A uniform `+1000` per-instance stride is applied to every managed port/base.

For example:

- VM1 Player/Game `7777-7810`, IGW `7888-7921`
- VM2 Player/Game `8777-8810`, IGW `8888-8921`
- VM3 Player/Game `9777-9810`, IGW `9888-9921`

The helper validates the complete interval set and fails closed on any collision or port above `65535`.

### Documentation

Adds a detailed SOP covering:

- one-VM-per-battlegroup isolation;
- source-derived default ports;
- complete per-instance namespace planning;
- `.env` service-port configuration;
- authoritative UserEngine `Port` / `IGWPort` configuration;
- `SERVER_IP` vs `SERVER_BIND_IP`;
- player and IGW UDP forwarding;
- RMQ Game and RMQ Game HTTP forwarding;
- Web Console exposure;
- NAT reflection/hairpin validation;
- host firewall configuration;
- startup/readiness verification;
- packet capture;
- security;
- rollback;
- upgrade revalidation;
- troubleshooting.

### Helper

Adds `runtime/scripts/multi-server-config.py` with:

- `plan`
- `apply`
- `verify`

The helper derives current defaults from repository source instead of silently assuming historical values remain valid.

No existing runtime default is changed merely by merging this PR. The helper changes configuration only when explicitly invoked.
EOF
```

Open the PR:

```bash
gh pr create \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --base main \
  --head yacketrj:docs/multi-server-single-public-ip \
  --draft \
  --title "docs/runtime: add collision-free multi-server SOP and helper" \
  --body-file /tmp/multi-server-pr.md
```

---

# Step 14 - Verify the Upstream PR Scope

```bash
gh pr view \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --json number,title,url,isDraft,files
```

Expected files should be limited to the intended documentation/helper scope.

Review the patch:

```bash
gh pr diff --repo Red-Blink/dune-awakening-selfhost-docker
```

---

# Maintainer Acceptance Checklist

Before marking the upstream PR ready for review:

- [ ] Branch is based on current `Red-Blink/main`.
- [ ] No unrelated fork history is included.
- [ ] Python helper compiles.
- [ ] Three-instance plan succeeds.
- [ ] VM1, VM2, and VM3 game ranges are non-overlapping.
- [ ] VM1, VM2, and VM3 IGW ranges are non-overlapping.
- [ ] Game ranges do not overlap any IGW range on any VM.
- [ ] No scalar service port overlaps a game or IGW range.
- [ ] No scalar service port is reused by another managed endpoint.
- [ ] Collision validation ignores protocol and checks numeric ownership globally.
- [ ] Instance 34 is rejected at the validated baseline because the generated port space is exhausted.
- [ ] Documentation tables match helper output.
- [ ] Router/NAT examples match helper output.
- [ ] UserEngine examples match helper output.
- [ ] Obsolete mixed-stride values are not used as active configuration.
- [ ] `git diff --check` passes.
- [ ] Upstream PR file list is limited to the intended deliverables.

The definitive operator behavior remains documented in [`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md).
