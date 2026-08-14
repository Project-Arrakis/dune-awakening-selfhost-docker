# Multi-Server Guide: Staging and Upstream Pull Request Workflow

**Status:** Current | **Last Updated:** August 2026

This is the maintainer/contributor companion to [`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md). It records the clean upstream submission workflow for the multi-server SOP, configuration helper, and the backwards-compatible RabbitMQ host-port change needed to make the complete repo-managed host namespace unique across VMs.

Staging PR:

```text
https://github.com/yacketrj/dune-awakening-selfhost-docker/pull/262
```

Upstream target:

```text
Red-Blink/dune-awakening-selfhost-docker
```

---

# Required Port-Policy Invariant

The upstream candidate must enforce:

> **No repo-managed host-facing/published numeric port or range may overlap another managed host port or range across any generated VM, regardless of protocol.**

Container-internal-only ports are not part of this host/public collision domain.

The standard allocation is:

```text
INSTANCE_PORT_STRIDE = 1000
instance_offset = (instance_number - 1) * 1000
```

Every managed scalar host port and every Player/Game or IGW range base receives the same offset.

## Required three-instance values

| Function | VM1 | VM2 | VM3 |
|---|---:|---:|---:|
| Player/Game UDP | `7777-7810` | `8777-8810` | `9777-9810` |
| IGW UDP | `7888-7921` | `8888-8921` | `9888-9921` |
| Text Router TCP | `5059` | `6059` | `7059` |
| Admin Web TCP | `8088` | `9088` | `10088` |
| Prometheus TCP | `9090` | `10090` | `11090` |
| Director TCP | `11717` | `12717` | `13717` |
| PostgreSQL TCP | `15432` | `16432` | `17432` |
| RMQ Game local HTTP TCP | `15672` | `16672` | `17672` |
| RMQ Game TCP | `31982` | `32982` | `33982` |
| RMQ Game HTTP TCP | `31983` | `32983` | `33983` |
| RMQ Admin TCP | `32573` | `33573` | `34573` |

The obsolete mixed-offset VM2 profile using Player/Game `7877-7910` and IGW `7988-8021` must not appear as active configuration because it overlaps VM1 IGW `7888-7921`.

---

# Why `start-rabbitmq.sh` Is Part of the Upstream Change

The audited upstream baseline hard-codes this host-side loopback mapping:

```text
127.0.0.1:15672 -> dune-rmq-game:15672
```

That means every VM uses the same host-side numeric port even though VM namespaces isolate it.

For the strict global host-port policy, the staging branch makes only the **host-side** port configurable:

```env
RMQ_GAME_LOCAL_HTTP_PORT=15672
```

Stock behavior remains unchanged because the default is still `15672`.

Multi-server examples become:

```text
VM1 15672 -> container 15672
VM2 16672 -> container 15672
VM3 17672 -> container 15672
```

No RabbitMQ container protocol or internal management port changes.

---

# Intended Upstream File Scope

Required files:

```text
.env.example
docs/README.md
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md
runtime/scripts/multi-server-config.py
runtime/scripts/start-rabbitmq.sh
```

Optional maintainer companion:

```text
docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

No other runtime behavior should change.

---

# Step 1 — Validate GitHub CLI and remotes

```bash
git --version
gh --version
gh auth status
git remote -v
```

Recommended remotes:

```text
origin    https://github.com/yacketrj/dune-awakening-selfhost-docker.git
upstream  https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

Add upstream if needed:

```bash
git remote add upstream https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
```

---

# Step 2 — Fetch current refs

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

# Step 3 — Create a clean branch from current upstream

```bash
git switch -c docs/multi-server-single-public-ip upstream/main
```

Confirm ancestry:

```bash
git merge-base --is-ancestor upstream/main HEAD && \
  echo "branch is based on upstream/main"
```

---

# Step 4 — Copy only reviewed files from the staging branch

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  .env.example \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py \
  runtime/scripts/start-rabbitmq.sh
```

If including this maintainer companion:

```bash
git checkout origin/agent/multi-server-single-public-ip-guide -- \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Do **not** replace upstream `docs/README.md` with the fork's copy. Edit the current upstream index in place.

---

# Step 5 — Add the current upstream documentation-index entry

Under `## Runtime` in `docs/README.md`, add:

```markdown
- [MULTI-SERVER-SINGLE-PUBLIC-IP.md](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. Executive overview and detailed SOP for running multiple isolated Dune battlegroups behind one public IPv4 with globally non-overlapping host-port profiles, NAT/hairpin validation, UserEngine configuration, rollback, and the multi-server configuration helper.
```

Review the surrounding current upstream index rather than assuming an old insertion point still exists.

---

# Step 6 — Syntax checks

Python:

```bash
python3 -m py_compile runtime/scripts/multi-server-config.py
```

RabbitMQ startup script:

```bash
bash -n runtime/scripts/start-rabbitmq.sh
```

Both must exit zero.

---

# Step 7 — Confirm the source-derived defaults

Run:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 1
```

The derived stock host values should include:

```text
Player/Game UDP          7777-7810
IGW UDP                  7888-7921
Text Router TCP          5059
Admin Web TCP            8088
Prometheus TCP           9090
Director TCP             11717
PostgreSQL TCP           15432
RMQ Game local HTTP TCP  15672
RMQ Game TCP             31982
RMQ Game HTTP TCP        31983
RMQ Admin TCP            32573
```

If the helper cannot derive one of these from the current upstream source layout, do not weaken the check merely to make the PR pass. Review the upstream change and update the parser deliberately.

---

# Step 8 — Validate the three-instance plan

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 | tee /tmp/dune-multiserver-plan.txt
```

Required stride:

```text
Global instance port stride: +1000
```

VM2 must include:

```text
Player/game UDP          8777-8810
IGW UDP                  8888-8921
Text Router TCP          6059
Admin Web TCP            9088
Prometheus TCP           10090
Director TCP             12717
PostgreSQL TCP           16432
RMQ Game local HTTP TCP  16672
RMQ Game TCP             32982
RMQ Game HTTP TCP        32983
RMQ Admin TCP            33573
```

VM3 must include:

```text
Player/game UDP          9777-9810
IGW UDP                  9888-9921
Text Router TCP          7059
Admin Web TCP            10088
Prometheus TCP           11090
Director TCP             13717
PostgreSQL TCP           17432
RMQ Game local HTTP TCP  17672
RMQ Game TCP             33982
RMQ Game HTTP TCP        33983
RMQ Admin TCP            34573
```

Required final result:

```text
VALIDATION: all generated managed host ports are globally non-overlapping.
```

---

# Step 9 — Verify generated NAT rules include IGW

The plan must show both UDP ranges for each instance.

VM2 example:

```text
UDP 8777-8810 -> <VM_LAN_IP>:8777-8810  # Player/Game
UDP 8888-8921 -> <VM_LAN_IP>:8888-8921  # IGW
TCP 32982 -> <VM_LAN_IP>:32982           # RMQ Game
TCP 32983 -> <VM_LAN_IP>:32983           # RMQ Game HTTP
```

Failure to emit IGW is a blocker for this deployment model.

---

# Step 10 — Validate the boundary behavior

At the audited baseline, Instance 33 should still fit and Instance 34 should fail because a generated port exceeds `65535`.

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 33 \
  >/tmp/dune-plan-33.txt

grep -F \
  'VALIDATION: all generated managed host ports are globally non-overlapping.' \
  /tmp/dune-plan-33.txt
```

Then:

```bash
if python3 runtime/scripts/multi-server-config.py plan --instances 34; then
  echo "ERROR: instance 34 unexpectedly passed"
  exit 1
else
  echo "PASS: instance 34 was rejected"
fi
```

This validates address-space exhaustion only; it does not assert that a physical host can support 33 battlegroups.

---

# Step 11 — Check the RabbitMQ local host mapping

Confirm the host side is configurable and the container side remains fixed:

```bash
grep -nE \
  'RMQ_GAME_LOCAL_HTTP_PORT|15672/tcp' \
  runtime/scripts/start-rabbitmq.sh
```

Expected design:

```text
RMQ_GAME_LOCAL_HTTP_PORT defaults to 15672
127.0.0.1:${RMQ_GAME_LOCAL_HTTP_PORT}:15672/tcp
```

There must not be an active hard-coded host-side `127.0.0.1:15672:15672/tcp` mapping left.

---

# Step 12 — Search for obsolete active port examples

```bash
grep -RniE \
  '7877|7910|7988|8021|5159|8090' \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md \
  runtime/scripts/multi-server-config.py || true
```

Historical text explaining why those values were rejected is acceptable. They must not appear as current VM2 configuration or expected output.

---

# Step 13 — Review the full diff

```bash
git diff --check

git status --short

git diff -- \
  .env.example \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md \
  runtime/scripts/multi-server-config.py \
  runtime/scripts/start-rabbitmq.sh
```

Confirm no unrelated runtime/application change is included.

---

# Step 14 — Commit

```bash
git add \
  .env.example \
  docs/README.md \
  docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md \
  runtime/scripts/multi-server-config.py \
  runtime/scripts/start-rabbitmq.sh
```

If including the maintainer companion:

```bash
git add docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md
```

Commit:

```bash
git commit -m "docs/runtime: add collision-free multi-server SOP and helper"
```

---

# Step 15 — Push the clean branch

```bash
git push -u origin docs/multi-server-single-public-ip
```

---

# Step 16 — Create the upstream draft PR

Create a PR body:

```bash
cat >/tmp/multi-server-pr.md <<'EOF'
## Summary

Adds a source-driven operator SOP and configuration helper for running multiple independent Dune: Awakening battlegroups on isolated VMs behind one shared public IPv4.

### Global host-port invariant

No repo-managed host-facing/published numeric port or range may overlap another managed host port or range across any generated VM, regardless of protocol.

The standard profile applies a uniform `+1000` per-instance offset to every managed host port/base.

Examples:

- VM1 Player/Game `7777-7810`, IGW `7888-7921`
- VM2 Player/Game `8777-8810`, IGW `8888-8921`
- VM3 Player/Game `9777-9810`, IGW `9888-9921`

The allocator also covers PostgreSQL, RMQ Admin, RMQ Game, RMQ Game HTTP, RMQ local-management HTTP, Text Router, Director, Admin Web, and optional Prometheus.

### Small runtime compatibility change

`start-rabbitmq.sh` previously hard-coded host mapping `127.0.0.1:15672:15672` for game RabbitMQ management. This PR makes only the host-side port configurable through `RMQ_GAME_LOCAL_HTTP_PORT`, defaulting to `15672`, so normal single-server behavior is unchanged while multi-VM deployments can assign `16672`, `17672`, etc.

### Helper

Adds `runtime/scripts/multi-server-config.py` with:

- `plan`
- `apply`
- `verify`

The helper derives defaults from repository source, checks all host-port intervals globally, fails closed on collisions or ports above `65535`, updates `.env`, writes authoritative UserEngine `Port` / `IGWPort`, and prints Player/Game + IGW + RMQ NAT rules.

### Documentation

Adds an executive architecture summary and detailed SOP covering VM isolation, complete port planning, NAT/hairpin behavior, firewalling, validation, packet capture, security, upgrades, and rollback.
EOF
```

Open the draft PR:

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

# Step 17 — Verify upstream PR scope

```bash
gh pr view \
  --repo Red-Blink/dune-awakening-selfhost-docker \
  --json number,title,url,isDraft,files
```

Then inspect:

```bash
gh pr diff --repo Red-Blink/dune-awakening-selfhost-docker
```

---

# Maintainer Acceptance Checklist

Before marking the upstream PR ready:

- [ ] Clean branch is based on current `Red-Blink/main`.
- [ ] No unrelated fork history is present.
- [ ] `python3 -m py_compile runtime/scripts/multi-server-config.py` passes.
- [ ] `bash -n runtime/scripts/start-rabbitmq.sh` passes.
- [ ] Three-instance plan passes global collision validation.
- [ ] Player/Game ranges are unique.
- [ ] IGW ranges are unique.
- [ ] No Player/Game range overlaps any IGW range.
- [ ] No scalar host port falls inside any Player/Game/IGW range.
- [ ] No scalar host port is reused by another managed endpoint.
- [ ] RMQ local-management host ports are `15672`, `16672`, `17672` for VM1-3.
- [ ] Prometheus host ports are `9090`, `10090`, `11090` for VM1-3.
- [ ] Generated NAT output contains IGW forwarding.
- [ ] Instance 34 fails at the audited baseline because the host-port space is exhausted.
- [ ] `.env.example` documents the advanced host-port overrides.
- [ ] Documentation tables match helper output.
- [ ] UserEngine examples match helper output.
- [ ] NAT examples match helper output.
- [ ] Obsolete mixed-offset values are not active configuration.
- [ ] Container-internal ports are not confused with host-facing ports.
- [ ] `git diff --check` passes.
- [ ] PR file list is limited to intended scope.

The definitive operator SOP remains [`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md).
