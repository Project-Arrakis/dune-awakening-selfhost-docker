# Guided Instance-Number Setup: `dune init` and the Console Setup Wizard

**Status:** Draft, implemented, not yet upstream | **Last Updated:** August 2026

This document describes a new, small feature layered on top of
[`MULTI-SERVER-SINGLE-PUBLIC-IP.md`](MULTI-SERVER-SINGLE-PUBLIC-IP.md)'s
`multi-server-config.py` helper: a single, explicit "what instance number is
this?" question in both `dune init` (CLI) and the console's Setup Wizard,
which derives every port from that one answer instead of requiring an
operator to edit `.env`'s 11 individual port fields by hand and separately
remember to run `usersettings.py engine-set`/`materialize-current`.

It also documents a real, live production bug this gap caused, the design
decisions made in response, and an explicit, out-of-scope future requirement
(automatic cross-install collision detection) that this feature deliberately
does **not** attempt to solve, along with why.

Tracking issues: [`yacketrj/dune-awakening-selfhost-docker#277`](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/277)
(this feature) and
[`#278`](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/278)
(the future phone-home follow-up).

---

# Why This Exists: A Real, Live Production Bug

While answering an operator's question about this exact topic, a live
instance of the class of bug this feature exists to prevent was found and
fixed on a real R740 deployment (`dune-dev`, one of two VMs sharing a public
IPv4 alongside `dune-prod`):

- `.env` had `CLIENT_PORT_BASE=8777` / `IGW_PORT_BASE=8888` set (apparently in
  preparation for Instance 2 configuration).
- The console's `/api/auth/state` endpoint reported `clientBase: 8777` --
  correctly reflecting `.env`, per that version of the code.
- The **actual running game server process** was bound to UDP `7777` (the
  stock Instance 1 value), confirmed directly via `ss -ulnp`.
- `runtime/generated/gameplay-profile.ini` had no `[Engine:URL]` section at
  all, and `runtime/generated/usersettings.json`'s `engine.port`/`engine.
  igw_port` were both `null`.
- The router's public port-forward rule (`UDP 8777-8810 -> 192.168.21.10`)
  was consequently non-functional -- forwarding a public port range to an
  internal port nothing was listening on.

Root cause: setting `.env`'s port variables does **not**, by itself, change
what the game engine binds to. That requires a separate,
easy-to-forget step: `usersettings.py engine-set port <value>` /
`engine-set igw_port <value>` followed by `materialize-current`. An operator
(or an earlier session) had done the first half and never completed the
second. Compounding this, the version of `console/api/src/config.js` running
at the time predated the Requirement 20 audit work on issue #266/#268/
upstream `Red-Blink#157`, and read `.env`'s `CLIENT_PORT_BASE`/`IGW_PORT_BASE`
directly rather than the real, authoritative `gameplay-profile.ini` -- so the
console displayed a port the server was never listening on, with nothing
surfacing the inconsistency.

**Fix applied to `dune-dev` in the same session** (tracked as
[`#275`](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/275)):
deployed the fully audited port-config fix, then manually ran
`engine-set port 8777`, `engine-set igw_port 8888`, `materialize-current`,
backed up the affected files first, and restarted both game-map containers.
Verified end-to-end afterward: `.env`, `gameplay-profile.ini`,
`UserEngine.ini`, the real `ss -ulnp` listeners, the console's own
`/api/auth/state`, and the router's port-forward rule all agreed at
`8777`/`8888`, and `dune status` reported `Overall: READY`.

**This feature exists so that sequence -- set `.env`, forget to
materialize, silently drift -- has no path to happen at all.** The operator
answers one question; every port is derived, shown for confirmation, and
applied atomically by the same tool, in the same step.

---

# Design

## The core principle: one number, not eleven

The operator is never asked to type an individual port. They pick "single
server" (the default, requiring zero additional input) or "part of a
multi-server group" plus a plain instance number (1-33, matching
`multi-server-config.py`'s own documented ceiling -- a generated port would
exceed 65535 at instance 34). Every one of the 11 managed ports is derived
from that number via the existing `+1000`-per-instance stride
`multi-server-config.py plan` already computes, shown in full before
anything is written, and applied by that same tool -- never a second,
parallel implementation of "what does instance N mean."

## One mechanism, three entry points

`dune init` (CLI), the console's Setup Wizard "Ports and Firewall" step, and
a direct `dune multi-server apply ...` invocation all resolve to the
identical underlying `runtime/scripts/multi-server-config.py apply` call.
This is deliberate: the Layer 1/2/3 audits already run against the port
resolution work (issue #266) spent real effort catching cases where two
independent implementations of "resolve this port" silently disagreed (see
that work's own `portResolutionCrossConsistency.test.js`). This feature does
not repeat that mistake by giving `init.sh` or the console their own port-math.

## What was actually built

### `runtime/scripts/dune multi-server <plan|apply|verify>`

A thin dispatch added to the `dune` CLI wrapper
(`case "$cmd" in ... multi-server) python3 runtime/scripts/multi-server-config.py "$@" ;; ...`),
so every other entry point (the console's task runner, a future CLI
enhancement) can reach the existing tool through the same `dune <subcommand>`
convention every other feature in this repo already uses, rather than
hardcoding a `python3 runtime/scripts/multi-server-config.py` path in
multiple places.

### `dune init`'s new prompt (interactive/CLI path only)

Inserted immediately after the existing public/local IP-mode selection
(since `apply` needs both a public IP and a bind IP, and the public IP is
exactly what that step already collects):

```text
Is this the only Dune server on this network, or one of several sharing infrastructure?
  1) Single server (default -- most operators want this)
  2) Part of a multi-server group behind one public IP

Choice [1]: 2

Instance number for this server (1 = first/primary, 2 = second, etc.) [1]: 2

This will configure Instance 2's ports:
  instance=2
  client=8777
  client_end=8810
  igw=8888
  igw_end=8921
  postgres=16432
  rmq_admin=33573
  rmq_game=32982
  rmq_game_http=32983
  rmq_game_local_http=16672
  text_router=6059
  director=12717
  admin_web=9088
  prometheus=10090

These will not collide with any other instance number's ports -- but this tool
cannot detect other Dune installations on your network. If you have already
used instance number 2 elsewhere, do NOT proceed -- pick a different number.

Continue with instance 2? [Y/n]:
```

Choosing "1" (or pressing Enter) skips all of this silently -- **zero new
questions for the existing single-server path**, which is the large majority
of installs and must never gain friction from this feature. Choosing "2"
computes the plan via `multi-server-config.py plan --instances N --json`
(read-only, no filesystem writes), shows every real number, requires an
explicit `Y`, then calls `multi-server-config.py apply --instance N
--public-ip "$SERVER_IP" --bind-ip "$(detect_lan_ip)" --allow-running` (the
existing, already-backup-safe apply path -- this init.sh change adds no new
backup/write logic of its own).

If the operator is setting up a **local/LAN-only** server (not `public`
mode), the prompt still asks the question but declines to apply a multi-server
profile, since `multi-server-config.py`'s own design (and this repo's public
NAT/hairpin guidance) assumes a shared public IP is the reason multiple
instances need non-overlapping ports in the first place. A local-only,
same-LAN multi-instance setup is out of this feature's scope.

### Console Setup Wizard's "Ports and Firewall" step (was read-only, now has real input)

The existing step already existed but only *displayed* resolved ports; it
took no input at all. Added, at the top of that step:

- A radio choice: "Single server" (default) or "Part of a multi-server
  group" with an adjacent instance-number field (1-33).
- The moment "multi-server" is selected (or the instance number changes), the
  frontend calls a new, read-only `POST /api/setup/multi-server-plan`
  endpoint and displays the *exact* resulting ports -- never a placeholder,
  never "instance 2 configured" with no detail.
- The same explicit "this tool cannot detect other installations" warning
  language as the CLI, plus an explicit checkbox the operator must tick
  before the apply button enables. No implicit consent.
- A restart warning: applying this stops and restarts every game map. This
  reuses the same disruptive-change discipline the rest of this console
  already applies to other settings changes.
- On confirm, calls a new `POST /api/setup/multi-server-apply`, which creates
  a task (`multiServerApplyAndRestart`) composed as `["stop",
  "multiServerApply", "start"]` -- the stack is always fully stopped first,
  both because `multi-server-config.py apply` itself refuses partial
  application against a live stack by default, and because every one of the
  11 ports it rewrites is read once at container start (Compose env
  interpolation), not live-reloaded -- a partial/service-scoped restart
  would leave other containers still bound to old ports.
- This step is now reachable from **both** first-run and redeploy wizard
  modes (`redeploySteps` previously omitted "ports" entirely) -- converting
  an existing single-server install to multi-server later is a legitimate,
  supported operation, not just a first-run-only concern.

### Backend (`console/api`)

- `POST /api/setup/multi-server-plan` -- read-only. Calls
  `buildDuneArgs("multiServerPlan", { instances })` ->
  `["multi-server", "plan", "--instances", "N", "--json"]`, parses and
  returns the tool's own JSON verbatim. Cannot leave the repo in a different
  state than it started in (`multi-server-config.py plan` performs no writes),
  so it is a plain command, not a task -- no audit-log entry beyond the
  normal request log, matching this codebase's own convention for read-only
  previews elsewhere (`safeCommand`/`safeCommandJson`).
- `POST /api/setup/multi-server-apply` -- real, disruptive, audited. The
  request body supplies only `instance` and `publicIp`; **`bindIp` is
  deliberately computed server-side** via the same `detectPrivateIpv4()`
  helper `config.js` already uses to resolve `ADMIN_BIND_HOST=auto` --
  the browser has no way to know this host's own LAN interface, and trusting
  a client-supplied bind IP would let a malformed/wrong value reach a
  subprocess argv. Writes `DUNE_INSTANCE_NUMBER` to `.env` (separately from
  `multi-server-config.py`'s own 11 port writes) purely so a later `dune
  init` run can display which instance this install is without
  reverse-engineering it from port numbers. Creates the composed
  `multiServerApplyAndRestart` task described above.
- `runner.js`'s `buildDuneArgs()` gained a `validateIpv4()` helper (rejects
  anything that isn't a literal, well-formed IPv4 address -- no DNS
  resolution, no IPv6) so a malformed public IP can never reach
  `multi-server-config.py`'s own argv unvalidated, matching every other
  `validate*()` guard already in that file.
- `actions.js`'s `ROUTE_ACTIONS` IAM table was updated for both new routes
  (`setup:read` for the plan preview, `setup:write` for the real apply) --
  caught automatically by this repo's own existing
  `rbacParity.test.js` ("every non-adapter route in handleApi has an IAM
  action"), which failed the first time these routes were added without it.
  This is exactly the kind of automated guardrail Requirement 20's Security
  Architect hat looks for, and it worked as designed.

### Frontend port-cache refresh after a live apply

`console/web/src/api/serverPorts.ts`'s own documented "CALLER CONTRACT" (see
issue #266/#273's Layer 2/3 audit findings) warns that its cache is an
imperative, mount-time read that will not automatically reflect a later
change. Since the Setup Wizard applies a real port change *while it is still
mounted*, `watchMultiServerTask()` re-fetches `/api/auth/state` and pushes
the fresh ports back into that shared cache on success -- otherwise the
wizard's own "Review" step (and anything else rendered later in the same
session) would keep showing the stale pre-apply values, silently
reintroducing the exact class of staleness bug the rest of this
workstream has already spent three audit layers fixing.

## Tests

- `console/api/test/runner.test.js` -- `buildDuneArgs()`/`taskOperations()`
  argv-shape and validation coverage for `multiServerPlan`, `multiServerApply`,
  and `multiServerApplyAndRestart` (instance range 1-33, IPv4 validation,
  the always-stop-then-apply-then-start task composition).
- `console/api/test/multiServerConfig.test.js` -- **real integration tests**,
  not mocks: runs the actual `runtime/scripts/dune multi-server plan`
  pipeline (real subprocess, real `multi-server-config.py`) and asserts on
  its real JSON output, including the documented 33-instance ceiling.
  Written deliberately in the same spirit as the port-resolver work's own
  cross-consistency tests -- an argv-shape unit test alone would not have
  caught a real integration break between `runner.js` and the actual tool.
- `console/web/src/components/SetupWizard.multiServer.test.tsx` -- 5 tests
  covering: default-to-single-server (never calls the plan endpoint
  unprompted), plan fetch + display + confirmation gating, re-fetch on
  instance-number change and plan-clearing on switching back to single,
  the public-mode requirement, and the actual apply call with the
  server-resolved public IP.

All new tests pass; the existing suite (1066/1122 relevant API tests, 47
pre-existing failures unrelated to this change -- see issue `#245`'s
already-tracked baseline; 252/252 web tests) is otherwise unaffected. `tsc`,
`shellcheck -S warning`, `semgrep --config p/default`, and `gitleaks` are all
clean on every touched file (one each of a pre-existing, unrelated
shellcheck warning and gitleaks/semgrep finding were independently confirmed
to predate this change).

---

# What This Feature Deliberately Does NOT Solve

## No automatic detection of an instance number already used elsewhere

This was investigated directly against the real infrastructure this feature
was designed for (an R740 host running `dune-prod`/`dune-dev` as two
separate VMs) rather than assumed:

- `dune-dev` cannot reach `dune-prod` over the network at all (confirmed via
  a direct TCP probe in both directions -- both timed out).
- Neither VM can reach the Proxmox hypervisor itself (also confirmed via a
  direct probe) -- this is the documented Prod-Zone/Dev-Zone firewall
  isolation.
- Both VMs *can* reach the public internet (needed for `dune update`'s own
  self-update mechanism already).

**There is no network path for one install to learn what instance number
another install already claimed, on this topology.** This is a hard
infrastructure fact, not a design choice this feature could route around.
Any design assuming LAN peer discovery between installs would not work here,
and there is no reason to believe most other operators' topologies are more
permissive than this one (isolated VMs behind one router is exactly the
architecture `MULTI-SERVER-SINGLE-PUBLIC-IP.md` itself recommends).

Given that, this feature's confirmation step says so explicitly, every time
a plan is shown, rather than implying a check happened when it didn't:

> This tool cannot detect other Dune installations on your network. If you
> have already used instance number N elsewhere, do NOT proceed -- pick a
> different number.

This is intentionally blunt. A false sense of safety here is worse than an
honest "we can't check this."

## The only real fix requires a service every install *can* reach

The public internet is the one network path every install in this topology
does have. `console/api/src/services/publicDirectory.js` already implements
almost the right shape of a coordination mechanism for the public server
directory feature: every server generates a random identity locally on first
use (UUID + 32-byte secret), heartbeats to a real external service
(`https://dunedocker.app/api/v1/servers/heartbeat`), and already has a
working claim/verify round-trip pattern (`POST
/api/v1/servers/{serverId}/verify-claim`, driven by a 12-character code the
operator gets from DuneDocker.app). It's opt-in (`DUNE_PUBLIC_DIRECTORY_ENABLED`,
requires public mode), not silently always-on.

Extending that same service with something like `POST
/api/v1/servers/{serverId}/claim-instance-number`, scoped to an
operator-defined group (not global across every DuneDocker.app user), could
close this gap for real. This is **not** being built as part of this
feature, for three reasons, tracked in detail in issue `#278`:

1. `dunedocker.app` is third-party/upstream infrastructure. Extending its API
   is not a change this repo can make unilaterally -- it needs buy-in from
   whoever actually operates that service.
2. The existing heartbeat code treats every failure as soft (log, retry,
   never block the server from running). An instance-number *claim* used
   for real port allocation cannot be soft-fail the same way without
   reintroducing exactly the silent-drift bug documented above -- what
   happens if the claim call fails, times out, or two installs race on the
   same claim in the same second needs an explicit, tested answer, not an
   assumption borrowed from a different feature's failure-tolerance design.
3. Scope discipline: the upstream maintainer's own review feedback on the
   related multi-server PR (`Red-Blink#156`) explicitly asked for a
   *smaller* scope, not a bigger one. Bundling a new cross-service
   coordination API into that review would work against getting the
   current, smaller fix merged.

---

# Relationship to Other In-Flight Work

- Depends on `runtime/scripts/multi-server-config.py` and its documentation
  (currently staged as `yacketrj#262`, targeting upstream
  `Red-Blink#156`, both in draft pending the maintainer's requested scope
  reduction and live multi-VM testing -- see that PR's review comment,
  2026-08-14).
- Depends on the fully audited port-config fix (`yacketrj#268` / upstream
  `Red-Blink#157`) for `config.ports` to correctly reflect
  `gameplay-profile.ini` live, rather than a stale `.env` snapshot -- this
  is exactly the fix that was deployed to `dune-dev` alongside the manual
  `engine-set`/`materialize-current` correction described above.
- Complements, but does not replace, `multi-server-config.py verify`, which
  remains the correct tool for auditing an *already-applied* profile against
  what a given instance number should look like.
