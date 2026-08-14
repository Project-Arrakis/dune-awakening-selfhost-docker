# Running Multiple Dune: Awakening Servers Behind One Public IPv4

**Status:** Current | **Last Updated:** August 2026

This document is the operator guide and standard operating procedure (SOP) for running multiple independent `dune-awakening-selfhost-docker` battlegroups on one physical server while sharing one public IPv4 address.

The recommended architecture is **one isolated Linux VM per Dune battlegroup**. Proxmox VE is used in the examples, but the same design applies to KVM/libvirt, VMware, Hyper-V, or another hypervisor that provides independent guest network namespaces.

The guide is source-driven. Default ports, runtime bindings, advertised addresses, and the authoritative game-port configuration path are derived from the repository rather than from generic Docker assumptions.

> **Validated source baseline**
>
> - Upstream repository: `Red-Blink/dune-awakening-selfhost-docker`
> - Upstream `main` commit validated for this guide: `7b7d8f1950a278e6431519841d5408cf04c582fb`
> - Staging fork: `yacketrj/dune-awakening-selfhost-docker`
>
> Re-run the validation procedures in this SOP after upgrades. Defaults and runtime behavior can change.

---

# Executive Summary

## Objective

A single public IPv4 address can support multiple independent Dune: Awakening self-hosted battlegroups when each battlegroup has:

1. its own isolated VM and LAN IPv4 address;
2. its own Docker daemon and runtime state;
3. its own battlegroup identity and configuration;
4. a complete per-instance port namespace;
5. no numeric port overlap with any other managed endpoint on any other VM;
6. a distinct player/game UDP range;
7. a distinct IGW UDP range;
8. distinct RabbitMQ Game and RabbitMQ Game HTTP ports;
9. a distinct Admin Web port when the Web Console is externally reachable;
10. correct `SERVER_IP` and `SERVER_BIND_IP` values for NAT;
11. authoritative UserEngine `Port` and `IGWPort` values matching the assigned instance profile;
12. router/firewall rules matching the assigned profile;
13. working NAT reflection/hairpin behavior where a VM must reach services using its own advertised public IPv4.

Recommended topology:

```text
                              Internet
                                 |
                          One Public IPv4
                                 |
                         Firewall / Router
                                 |
                         Proxmox VE Host
                                 |
             +-------------------+-------------------+
             |                   |                   |
          DUNE-01             DUNE-02             DUNE-03
          VM #1               VM #2               VM #3
      192.168.68.127      192.168.68.128      192.168.68.129
          Docker               Docker               Docker
          Stack A              Stack B              Stack C
```

All VMs may advertise the **same public IPv4**. The router directs traffic to the correct VM by destination port and protocol.

---

## Non-negotiable port-allocation rule

For this guide, a numeric port is treated as globally owned by exactly one managed endpoint in the multi-VM deployment.

That rule is intentionally stricter than normal TCP/UDP socket semantics.

For example, this guide does **not** permit:

```text
VM1 IGW UDP     7888-7921
VM2 Game UDP    7877-7910
```

because the ranges overlap numerically at:

```text
7888-7910
```

Even though the services are on separate VMs, and even if an operator could technically distinguish some flows by protocol or internal address, the community profile rejects the overlap because:

- both ranges may be port-forwarded through the same public IPv4;
- firewall and NAT configuration becomes ambiguous;
- packet captures become harder to interpret;
- observability and runbooks become less deterministic;
- future upstream binding changes can convert a harmless-looking overlap into a production outage;
- an authoritative community guide should not rely on accidental isolation to make an overlapping allocation safe.

**Every managed port and every managed range across every VM must be numerically non-overlapping.**

---

## Standard allocation policy: one uniform +1000 stride

The community profile uses the stock upstream single-server values for Instance 1.

For every additional instance:

```text
instance_offset = (instance_number - 1) * 1000
```

Every managed port and every managed range base receives that same offset.

Examples:

```text
VM1 offset = 0
VM2 offset = 1000
VM3 offset = 2000
VM4 offset = 3000
```

For a scalar port:

```text
instance_port = stock_port + instance_offset
```

For player and IGW ranges:

```text
instance_start = stock_start + instance_offset
instance_end   = stock_end   + instance_offset
```

This policy is easy to inspect manually and is enforced by the included `multi-server-config.py` helper.

---

## Collision-free VM1 / VM2 / VM3 profiles

| Function | VM1 / Instance 1 | VM2 / Instance 2 | VM3 / Instance 3 |
|---|---:|---:|---:|
| Player/game UDP base | `7777` | `8777` | `9777` |
| Player/game UDP pool | `7777-7810` | `8777-8810` | `9777-9810` |
| IGW UDP base | `7888` | `8888` | `9888` |
| IGW UDP pool | `7888-7921` | `8888-8921` | `9888-9921` |
| Admin Web TCP | `8088` | `9088` | `10088` |
| Text Router TCP | `5059` | `6059` | `7059` |
| Director TCP | `11717` | `12717` | `13717` |
| PostgreSQL TCP | `15432` | `16432` | `17432` |
| RMQ Game TCP | `31982` | `32982` | `33982` |
| RMQ Game HTTP TCP | `31983` | `32983` | `33983` |
| RMQ Admin TCP | `32573` | `33573` | `34573` |

There are **no numeric overlaps** anywhere in this three-VM profile.

The helper validates the full set before displaying or applying a plan:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

Expected final line:

```text
VALIDATION: all generated managed ports are globally non-overlapping.
```

With the validated current defaults and a `+1000` stride, the helper remains collision-free through Instance 33. Instance 34 is rejected because a generated RMQ Admin port would exceed `65535`.

This is a **port-space observation**, not a recommendation to run 33 battlegroups on one physical host. CPU, RAM, storage IOPS, database load, and game-server scheduling will impose much lower practical limits.

---

## Do not use the earlier mixed-stride example

An earlier example used different offsets for different services, including:

```text
CLIENT_PORT_BASE=7877
IGW_PORT_BASE=7988
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_WEB_PORT=8090
```

The service values were individually configurable, but the game/IGW allocation was not globally safe because VM2's player range `7877-7910` overlapped VM1's IGW range `7888-7921`.

This guide supersedes that mixed-stride allocation.

Use the uniform `+1000` profile instead.

---

## Configuration sources: service ports vs game ports

There are two different configuration paths in current upstream.

### `.env`-backed service ports

The current runtime resolves the following through [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh):

```text
POSTGRES_PORT          15432
RMQ_ADMIN_PORT         32573
RMQ_GAME_PORT          31982
RMQ_GAME_HTTP_PORT     31983
TEXT_ROUTER_PORT       5059
DIRECTOR_PORT          11717
```

The Web Console uses `ADMIN_BIND_PORT`, default `8088`, from [`.env.example`](../../.env.example) and [`docker-compose.web.yml`](../../docker-compose.web.yml). `docker-compose.web.yml` also recognizes `ADMIN_WEB_PORT` as an override alias.

### UserEngine-backed player and IGW ports

The authoritative game network settings are:

```ini
[URL]
Port=7777
IGWPort=7888
```

Sources:

- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)

Current runtime resolution uses `usersettings.py` / UserEngine state for these values.

Therefore an `.env` entry such as:

```env
CLIENT_PORT_BASE=8777
IGW_PORT_BASE=8888
```

is **not by itself sufficient** to make those values authoritative on the validated upstream baseline.

Use either:

- `manager.sh` UserEngine editing; or
- `usersettings.py engine-set`.

The included helper performs both the `.env` compatibility updates and authoritative UserEngine writes.

---

## Public vs bind address

For a server behind NAT:

```text
SERVER_IP       = public WAN IPv4 advertised to players/services
SERVER_BIND_IP  = VM LAN IPv4 where local sockets bind
SERVER_IP_MODE  = public
```

Example VM2:

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
```

[`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh) contains the NAT/public-host logic that distinguishes the advertised external address from the local bind address.

---

## Public forwarding set

In a shared-public-IPv4 deployment, assign unique ports to **all** managed services and explicitly forward the endpoints your deployment requires.

For the game/network paths covered by this SOP, plan public mappings for:

- player/game UDP range;
- IGW UDP range when it is routed/forwarded externally in your deployment;
- RMQ Game TCP;
- RMQ Game HTTP TCP;
- Admin Web TCP when direct external Web Console access is intentionally enabled.

The current upstream public-hosting path explicitly accounts for RMQ Game, RMQ Game HTTP, and player UDP. See:

- [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh)
- [`runtime/scripts/doctor.sh`](../../runtime/scripts/doctor.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)

IGW is the server-to-server range defined in UserEngine. If your router/firewall design forwards IGW through the public address, it must use the unique per-instance range in this guide.

PostgreSQL, RMQ Admin, Text Router, and Director are also assigned unique per-instance ports. Current upstream startup scripts bind several of them to loopback; do not assume that a router port forward alone makes a `127.0.0.1` listener externally reachable.

---

# Detailed Standard Operating Procedure

## SOP assumptions

This SOP assumes:

- one physical Proxmox/KVM/VMware/Hyper-V host;
- one public IPv4 address;
- two or more isolated Linux VMs;
- one independent Dune battlegroup per VM;
- a bridged or routed LAN behind a firewall/router;
- Docker Engine inside every VM;
- public Internet players;
- operator access to the hypervisor, VMs, router/firewall, and repository checkout.

Examples use:

```text
Public IPv4:   203.0.113.50      documentation example only
DUNE-01:       192.168.68.127
DUNE-02:       192.168.68.128
DUNE-03:       192.168.68.129
```

Replace those addresses with your real network values.

---

## Phase 0 - Change-control preparation

Before changing a running deployment:

1. identify every battlegroup and VM;
2. assign a permanent instance number to each VM;
3. record current `.env` files;
4. record current UserEngine `Port` and `IGWPort` values;
5. record router NAT/port-forward rules;
6. record VM firewall rules;
7. take a VM snapshot or equivalent backup where operationally appropriate;
8. confirm hypervisor console access in case remote networking is disrupted;
9. schedule a maintenance window if players are active.

On each VM:

```bash
cd /path/to/dune-awakening-selfhost-docker

cp -a .env ".env.pre-multiserver.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 runtime/scripts/usersettings.py engine-values

docker ps
ss -lntup
```

Record at minimum:

```text
port
igw_port
```

---

## Phase 1 - Validate the current repository defaults

Do not assume this document's numeric examples remain correct after an upstream update.

Run:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

The helper derives current defaults from the checked-out repository:

- service defaults from `runtime/scripts/runtime-env.sh`;
- UserEngine `Port` / `IGWPort` defaults from `runtime/scripts/usersettings.py`;
- dynamic game and IGW pool maximum offsets from `runtime/scripts/spawn-server.sh`;
- Admin Web default from `.env.example`.

For the validated baseline, Instance 1 should resolve to:

```text
Player/game UDP   7777-7810
IGW UDP           7888-7921
PostgreSQL TCP    15432
RMQ Admin TCP     32573
RMQ Game TCP      31982
RMQ Game HTTP     31983
Text Router TCP   5059
Director TCP      11717
Admin Web TCP     8088
```

If the helper cannot derive those source patterns, it fails closed rather than silently applying an obsolete port plan.

---

## Phase 2 - Create the VM isolation layer

Create one VM per battlegroup.

Example:

```text
DUNE-01 -> Instance 1 -> 192.168.68.127
DUNE-02 -> Instance 2 -> 192.168.68.128
DUNE-03 -> Instance 3 -> 192.168.68.129
```

Each VM should have:

- its own virtual NIC;
- its own static or DHCP-reserved IPv4;
- its own filesystem;
- its own Docker daemon;
- its own repository checkout;
- its own `.env`;
- its own `runtime/` data;
- sufficient RAM/CPU/storage for the intended map count.

A bridged Proxmox layout is straightforward:

```text
vmbr0
  |
  +-- DUNE-01 192.168.68.127
  +-- DUNE-02 192.168.68.128
  +-- DUNE-03 192.168.68.129
```

Validate each VM:

```bash
ip -4 addr
ip route
curl -4 https://api.ipify.org
```

All VMs behind the same router should normally report the same public IPv4.

---

## Phase 3 - Install one independent Dune stack per VM

Install the upstream project independently in each guest.

Do not treat two checkouts in one Linux host namespace as equivalent to two VMs. The runtime uses fixed container/resource naming and host networking in important paths; VM isolation avoids those collision classes.

Do not clone an already-initialized VM without intentionally regenerating battlegroup-specific identity/state that must be unique.

A typical checkout path might be:

```text
/opt/dune-awakening-selfhost-docker
```

Complete normal project initialization and valid Funcom/self-host authentication for every battlegroup.

---

## Phase 4 - Assign stable instance numbers

Instance numbers are part of the port namespace.

Example:

```text
DUNE-01 = 1
DUNE-02 = 2
DUNE-03 = 3
```

Do not renumber casually after NAT rules and monitoring are built.

The instance offset is:

```text
offset = (instance - 1) * 1000
```

Generate the authoritative plan:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

Machine-readable version:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

---

## Phase 5 - Review the complete collision domain

Before applying anything, review **all** managed allocations together.

For three instances the numeric space is:

```text
VM1
  Text Router       5059
  Game              7777-7810
  IGW               7888-7921
  Admin Web         8088
  Director          11717
  PostgreSQL        15432
  RMQ Game          31982
  RMQ Game HTTP     31983
  RMQ Admin         32573

VM2
  Text Router       6059
  Game              8777-8810
  IGW               8888-8921
  Admin Web         9088
  Director          12717
  PostgreSQL        16432
  RMQ Game          32982
  RMQ Game HTTP     32983
  RMQ Admin         33573

VM3
  Text Router       7059
  Game              9777-9810
  IGW               9888-9921
  Admin Web         10088
  Director          13717
  PostgreSQL        17432
  RMQ Game          33982
  RMQ Game HTTP     33983
  RMQ Admin         34573
```

The helper treats every scalar as a one-port interval and checks it against every other scalar/range, regardless of protocol.

If any overlap is found, `plan`, `apply`, and `verify` fail with a collision error.

---

## Phase 6 - Stop the Dune stack before changing ports

Changing ports while containers remain active creates stale listeners and ambiguous validation.

Use the project's normal stop workflow.

Then inspect:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

The helper refuses to apply a profile when Dune containers are running unless `--allow-running` is supplied.

Treat `--allow-running` as a staging-only escape hatch. Running processes continue using old listeners until restarted.

---

## Phase 7A - Automated configuration: recommended

### Dry-run VM2

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --dry-run
```

Expected VM2 profile:

```text
Player/game UDP   8777-8810
IGW UDP           8888-8921
PostgreSQL TCP    16432
RMQ Admin TCP     33573
RMQ Game TCP      32982
RMQ Game HTTP     32983
Text Router TCP   6059
Director TCP      12717
Admin Web TCP     9088
```

The dry run should also report:

```text
Global collision validation: PASS
```

### Apply VM2

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

The helper:

1. derives defaults from the checked-out source;
2. calculates the profile using the uniform `+1000` stride;
3. builds the complete allocation set from VM1 through the requested instance;
4. validates every scalar and range for numeric overlap;
5. validates all generated ports are between `1` and `65535`;
6. checks for active Dune containers;
7. creates a timestamped backup;
8. updates/inserts managed `.env` keys;
9. removes duplicate active definitions for managed `.env` keys;
10. writes authoritative UserEngine `IGWPort`;
11. writes authoritative UserEngine `Port`;
12. materializes runtime UserEngine/UserGame files;
13. prints the corresponding public NAT rules;
14. does not restart the stack automatically.

Backups are stored under:

```text
runtime/backups/multi-server-config-<UTC timestamp>/
```

Possible backup contents:

```text
.env
runtime/generated/usersettings.json
runtime/generated/gameplay-profile.ini
```

---

## Phase 7B - Manual configuration

Manual changes are useful for auditing the helper or for deployments that do not use it.

### VM1 / Instance 1

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.127

POSTGRES_PORT=15432
RMQ_ADMIN_PORT=32573
RMQ_GAME_PORT=31982
RMQ_GAME_HTTP_PORT=31983
TEXT_ROUTER_PORT=5059
DIRECTOR_PORT=11717
ADMIN_BIND_PORT=8088
ADMIN_WEB_PORT=8088

# Compatibility/console metadata; authoritative game values are UserEngine.
CLIENT_PORT_BASE=7777
IGW_PORT_BASE=7888
```

Authoritative UserEngine:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 7888
python3 runtime/scripts/usersettings.py engine-set port 7777
python3 runtime/scripts/usersettings.py materialize-current
```

### VM2 / Instance 2

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128

POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=6059
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=9088
ADMIN_WEB_PORT=9088

CLIENT_PORT_BASE=8777
IGW_PORT_BASE=8888
```

Authoritative UserEngine:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 8888
python3 runtime/scripts/usersettings.py engine-set port 8777
python3 runtime/scripts/usersettings.py materialize-current
```

### VM3 / Instance 3

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.129

POSTGRES_PORT=17432
RMQ_ADMIN_PORT=34573
RMQ_GAME_PORT=33982
RMQ_GAME_HTTP_PORT=33983
TEXT_ROUTER_PORT=7059
DIRECTOR_PORT=13717
ADMIN_BIND_PORT=10088
ADMIN_WEB_PORT=10088

CLIENT_PORT_BASE=9777
IGW_PORT_BASE=9888
```

Authoritative UserEngine:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 9888
python3 runtime/scripts/usersettings.py engine-set port 9777
python3 runtime/scripts/usersettings.py materialize-current
```

### Avoid duplicate `.env` definitions

Do not blindly append values if keys already exist.

Audit first:

```bash
grep -nE '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

Edit or replace existing active definitions rather than creating multiple copies.

The helper performs an update-or-insert operation automatically.

---

## Phase 8 - Manager-based UserEngine configuration

If you prefer the interactive manager:

```bash
runtime/scripts/manager.sh
```

Navigate to the UserEngine global-default editor.

The manager exposes:

```text
Port
IGWPort
```

Source: [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh).

Set:

```text
VM1: Port 7777, IGWPort 7888
VM2: Port 8777, IGWPort 8888
VM3: Port 9777, IGWPort 9888
```

Running map containers retain old values until restarted.

---

## Phase 9 - Configure router NAT / port forwarding

Use **1:1 external-to-internal port translation** wherever possible.

Do this:

```text
PUBLIC:32982 -> VM2:32982
```

Avoid unnecessary remapping such as:

```text
PUBLIC:32982 -> VM2:31982
```

because runtime registration and troubleshooting are simpler when public and internal port numbers match.

### VM1 forwarding

```text
UDP 7777-7810   -> 192.168.68.127:7777-7810   Player/Game
UDP 7888-7921   -> 192.168.68.127:7888-7921   IGW, when externally forwarded
TCP 31982       -> 192.168.68.127:31982       RMQ Game
TCP 31983       -> 192.168.68.127:31983       RMQ Game HTTP
TCP 8088        -> 192.168.68.127:8088        Admin Web, only if intentionally public
```

### VM2 forwarding

```text
UDP 8777-8810   -> 192.168.68.128:8777-8810   Player/Game
UDP 8888-8921   -> 192.168.68.128:8888-8921   IGW, when externally forwarded
TCP 32982       -> 192.168.68.128:32982       RMQ Game
TCP 32983       -> 192.168.68.128:32983       RMQ Game HTTP
TCP 9088        -> 192.168.68.128:9088        Admin Web, only if intentionally public
```

### VM3 forwarding

```text
UDP 9777-9810   -> 192.168.68.129:9777-9810   Player/Game
UDP 9888-9921   -> 192.168.68.129:9888-9921   IGW, when externally forwarded
TCP 33982       -> 192.168.68.129:33982       RMQ Game
TCP 33983       -> 192.168.68.129:33983       RMQ Game HTTP
TCP 10088       -> 192.168.68.129:10088       Admin Web, only if intentionally public
```

There is no overlap between the three forwarding sets.

---

## Phase 10 - Understand loopback-bound control-plane ports

This guide still gives the following a unique per-instance value:

```text
PostgreSQL
RMQ Admin
Text Router
Director
```

Current upstream startup scripts bind several of these to `127.0.0.1` on the VM host.

Examples:

- PostgreSQL: [`runtime/scripts/start-postgres.sh`](../../runtime/scripts/start-postgres.sh)
- RMQ Admin: [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- Text Router: [`runtime/scripts/start-text-router.sh`](../../runtime/scripts/start-text-router.sh)
- Director: [`runtime/scripts/start-director.sh`](../../runtime/scripts/start-director.sh)

A router forward to `192.168.68.x:<port>` does not automatically expose a process listening only on `127.0.0.1:<port>`.

The ports are nevertheless unique because the community policy treats the complete service namespace as instance-specific.

Do not rebind PostgreSQL or other control-plane services to the Internet without a reviewed operational requirement.

---

## Phase 11 - Configure VM firewall rules

The exact firewall product is site-specific. These examples use UFW.

### VM1

```bash
sudo ufw allow 31982/tcp
sudo ufw allow 31983/tcp
sudo ufw allow 7777:7810/udp
sudo ufw allow 7888:7921/udp
```

If Web Console access is allowed only from a management subnet:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 8088 proto tcp
```

### VM2

```bash
sudo ufw allow 32982/tcp
sudo ufw allow 32983/tcp
sudo ufw allow 8777:8810/udp
sudo ufw allow 8888:8921/udp
```

Management-only Web Console:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 9088 proto tcp
```

### VM3

```bash
sudo ufw allow 33982/tcp
sudo ufw allow 33983/tcp
sudo ufw allow 9777:9810/udp
sudo ufw allow 9888:9921/udp
```

Management-only Web Console:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 10088 proto tcp
```

Do not add WAN rules for PostgreSQL or other internal control-plane listeners without a defined requirement.

---

## Phase 12 - Validate NAT reflection / hairpin NAT

[`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh) launches Server Gateway with the advertised `SERVER_IP` plus the configured RMQ Game and RMQ Game HTTP ports.

For NAT-hosted environments, each VM may therefore need to reach its own public tuple and be translated back to itself.

VM1:

```bash
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983
```

VM2:

```bash
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983
```

VM3:

```bash
nc -vz 203.0.113.50 33982
nc -vz 203.0.113.50 33983
```

If external hosts connect but these local-to-public tests fail, investigate:

- NAT reflection / NAT loopback;
- split DNS/routing;
- policy routing;
- host firewall;
- router implementation details;
- double NAT or ISP gateway behavior.

---

## Phase 13 - Start the stack

After `.env`, UserEngine, VM firewall, and router NAT changes are complete, start the Dune stack using the project's normal command.

Do not validate only a single map. The dynamic allocator can consume additional player and IGW ports as maps/partitions start.

---

## Phase 14 - Verify saved configuration

### Helper verification

VM2:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

Expected:

```text
VERIFY: configuration matches expected profile.
Global collision validation: PASS
```

### Inspect `.env`

```bash
grep -E '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

VM2 expected:

```text
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=6059
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=9088
ADMIN_WEB_PORT=9088
CLIENT_PORT_BASE=8777
IGW_PORT_BASE=8888
```

### Inspect authoritative UserEngine values

```bash
python3 runtime/scripts/usersettings.py engine-values | grep -E '^(port|igw_port)'
```

VM2 expected:

```text
port        8777
igw_port    8888
```

### Inspect generated runtime UserEngine files

```bash
find runtime/game -path '*/Saved/UserSettings/UserEngine.ini' -print

grep -RniE '^\[URL\]|^Port=|^IGWPort=' \
  runtime/game/*/Saved/UserSettings/UserEngine.ini
```

---

## Phase 15 - Verify actual sockets and containers

Inspect host listeners:

```bash
ss -lntup
```

Inspect Docker:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

On VM2, verify expected listeners/allocations are using the VM2 namespace rather than VM1 defaults.

Pay particular attention to:

```text
8777-8810 UDP
8888-8921 UDP
16432 TCP
33573 TCP
32982 TCP
32983 TCP
6059 TCP
12717 TCP
9088 TCP
```

Not every port in a dynamic range must be actively listening at all times; usage depends on active map/server allocation.

---

## Phase 16 - Run project diagnostics

Run:

```bash
dune doctor
```

Then the normal readiness check used by your deployment, for example:

```bash
dune ready
```

The current `doctor.sh` resolves configured service ports and checks important listener/public-host conditions.

---

## Phase 17 - Validate game and IGW address registration

The runtime distinguishes player-facing game addresses from IGW/server-to-server addresses.

Source:

- [`runtime/scripts/network-addresses.sh`](../../runtime/scripts/network-addresses.sh)
- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)

Check:

```bash
runtime/scripts/network-addresses.sh status
```

Confirm:

- game addresses use the intended advertised/public IP;
- local binds use the intended `SERVER_BIND_IP`;
- player ports belong to the VM's assigned game range;
- IGW ports belong to the VM's assigned IGW range;
- no runtime state references another VM's range.

---

## Phase 18 - External validation

Test from a host genuinely outside the server LAN:

- cloud VM;
- mobile hotspot;
- second ISP/site;
- trusted remote system.

TCP checks:

```bash
# VM1
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983

# VM2
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983

# VM3
nc -vz 203.0.113.50 33982
nc -vz 203.0.113.50 33983
```

If Admin Web is intentionally public:

```bash
curl -I http://203.0.113.50:8088/
curl -I http://203.0.113.50:9088/
curl -I http://203.0.113.50:10088/
```

For UDP, a generic probe does not always receive an application response. The strongest validation is an actual game client discovering, joining, and traveling through the server topology while packet capture confirms the correct destination VM and port range.

---

## Phase 19 - Packet-capture validation

### VM1

```bash
sudo tcpdump -ni any \
  'tcp port 31982 or tcp port 31983 or tcp port 8088 or udp portrange 7777-7810 or udp portrange 7888-7921'
```

### VM2

```bash
sudo tcpdump -ni any \
  'tcp port 32982 or tcp port 32983 or tcp port 9088 or udp portrange 8777-8810 or udp portrange 8888-8921'
```

### VM3

```bash
sudo tcpdump -ni any \
  'tcp port 33982 or tcp port 33983 or tcp port 10088 or udp portrange 9777-9810 or udp portrange 9888-9921'
```

Packet capture should answer:

- Did the public packet arrive on the intended VM?
- Did it arrive on the intended unique port?
- Did the process reply?
- Is hairpin traffic translated back to the correct VM?
- Is any traffic unexpectedly using another VM's namespace?

---

## Phase 20 - Web Console security

The Web Console runs with host networking and the Compose definition mounts `/var/run/docker.sock`.

Source: [`docker-compose.web.yml`](../../docker-compose.web.yml).

That grants the console broad control over the Docker host.

Preferred access order:

1. LAN-only;
2. VPN;
3. authenticated reverse proxy with TLS and strict administrative controls;
4. direct WAN forwarding only when explicitly required and secured.

If direct public access is used, each VM must use its own unique Admin Web port from the instance profile.

---

## Phase 21 - Monitoring and observability

The optional metrics stack is a separate management plane.

Source: [`docker-compose.metrics.yml`](../../docker-compose.metrics.yml).

Do not merge metrics/dashboard endpoints into the game port plan without documenting them and checking the global collision invariant.

Recommended practice:

- Prometheus private;
- exporters private;
- Grafana behind VPN/reverse proxy/SSO;
- unique externally mapped ports or hostnames if multiple dashboards are exposed.

If you extend `multi-server-config.py` to manage additional observability ports, add them to the `Allocation` set so the same global collision validator covers them.

---

## Phase 22 - Security requirements

### Keep PostgreSQL private

PostgreSQL contains authoritative game state. Current upstream publishes it on loopback. Do not expose it directly to the WAN without a strong, reviewed requirement.

### Protect credentials and secrets

Do not commit:

- Funcom self-host tokens;
- RMQ secrets;
- database passwords;
- Web Console credentials;
- SSH private keys;
- generated API secrets.

### Use default-deny inbound policy

Only allow the public endpoints actually required by the deployment.

A unique per-instance port assignment is not permission to expose every listener.

---

## Phase 23 - Capacity planning

Port isolation solves network identity only.

Per VM, account for:

- active Sietch count;
- Deep Desert count;
- map memory limits;
- CPU scheduling latency;
- PostgreSQL memory/IO;
- Docker image/cache storage;
- log growth;
- metrics overhead;
- backup/snapshot I/O;
- hypervisor reserve.

Do not allocate 100% of physical RAM to guests.

Avoid CPU overcommit severe enough to introduce scheduling jitter into latency-sensitive game processes.

---

## Phase 24 - Upgrade procedure

After pulling upstream changes:

```bash
git pull
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

If the helper can no longer derive defaults or allocation sizes, stop and review source changes.

Inspect changes to:

```bash
git diff HEAD@{1} -- \
  .env.example \
  docker-compose*.yml \
  runtime/defaults/UserEngine.ini \
  runtime/scripts/runtime-env.sh \
  runtime/scripts/usersettings.py \
  runtime/scripts/manager.sh \
  runtime/scripts/spawn-server.sh \
  runtime/scripts/start-rabbitmq.sh \
  runtime/scripts/start-postgres.sh \
  runtime/scripts/start-text-router.sh \
  runtime/scripts/start-director.sh \
  runtime/scripts/start-server-gateway.sh \
  runtime/scripts/network-addresses.sh \
  runtime/scripts/init.sh \
  runtime/scripts/doctor.sh
```

Re-run the global collision plan before production restart.

---

## Phase 25 - Rollback

Stop the stack before restoring old network identity.

Find the newest helper backup:

```bash
ls -1dt runtime/backups/multi-server-config-* | head
```

Example:

```bash
BACKUP_DIR="runtime/backups/multi-server-config-YYYYMMDDTHHMMSSZ"
cp -a "$BACKUP_DIR/.env" .env
```

Restore generated settings files when present, preserving their relative paths.

Then:

```bash
python3 runtime/scripts/usersettings.py materialize-current
```

Restore prior firewall/NAT rules, restart the stack, and validate:

```bash
dune doctor
dune ready
```

---

# Troubleshooting Matrix

| Symptom | Likely cause | Checks |
|---|---|---|
| `plan` reports global collision | custom/default values violate global uniqueness | read both allocations named in error; choose a new non-overlapping plan |
| `plan` fails at high instance number | generated port exceeds `65535` | reduce instance count or design a reviewed custom allocation |
| VM2 still uses `7777` | `.env` changed but UserEngine `Port` was not | `usersettings.py engine-values`, generated `UserEngine.ini` |
| VM2 still uses `7888` IGW | `.env` changed but UserEngine `IGWPort` was not | `engine-values`, generated `UserEngine.ini` |
| VM2 players reach VM1 | stale/incorrect NAT destination | router rules, external test, `tcpdump` on both VMs |
| VM2 game works but IGW fails | IGW forward/firewall uses old or overlapping range | verify `8888-8921`, router, firewall, packet capture |
| Gateway cannot reach RMQ through public IP | hairpin/NAT reflection missing | `nc` from VM to public RMQ tuple |
| Web Console VM2 opens VM1 | wrong public Admin Web forwarding | confirm `9088 -> VM2:9088` |
| `dune doctor` reports old service port | `.env` override absent/duplicated | grep `.env`, inspect resolver defaults |
| dynamic map allocation fails | range exhaustion or runtime port still occupied | `ss -lnup`, spawn logs, active map count |
| helper refuses while containers run | safety guard | stop stack; use `--allow-running` only to stage |
| helper cannot derive defaults | upstream source layout changed | inspect source-of-truth files before updating helper |
| only LAN access works | WAN NAT/firewall or advertised IP issue | external packet capture, `SERVER_IP`, router rules |
| game socket attempts public-IP bind | bind/public NAT configuration issue | `SERVER_BIND_IP`, `dune doctor`, runtime NAT guard |

---

# Port Source and Runtime Behavior Reference

## Player/game `Port`

Stock default:

```text
7777
```

Sources:

- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)
- [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh)

The UserEngine comments describe `Port` as the starting player-listener port; subsequent servers use the next available ports.

At the validated baseline, dynamic allocation checks through base `+33`, producing a 34-port planning pool.

## IGW `IGWPort`

Stock default:

```text
7888
```

Sources:

- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)
- [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh)

The UserEngine comments identify IGW as the starting server-to-server port sequence and require the local game and IGW ranges not to intersect.

This community guide additionally requires IGW not to intersect **any other VM's** managed range or scalar port.

## PostgreSQL

Stock host port:

```text
15432/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-postgres.sh`](../../runtime/scripts/start-postgres.sh)

Current startup publishes PostgreSQL on loopback.

## RMQ Admin

Stock:

```text
32573/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)

Current host publish is loopback-only.

## RMQ Game

Stock:

```text
31982/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)

RMQ Game is host-published and Server Gateway receives the configured public host/port.

## RMQ Game HTTP

Stock:

```text
31983/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)
- [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh)

It is distinct from RMQ Game and receives its own per-instance port.

## Text Router

Stock:

```text
5059/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-text-router.sh`](../../runtime/scripts/start-text-router.sh)

## Director

Stock:

```text
11717/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-director.sh`](../../runtime/scripts/start-director.sh)
- game-server start/spawn scripts

## Admin Web

Stock:

```text
8088/TCP
```

Sources:

- [`.env.example`](../../.env.example)
- [`install.sh`](../../install.sh)
- [`docker-compose.web.yml`](../../docker-compose.web.yml)
- [`console/api/src/config.js`](../../console/api/src/config.js)

`ADMIN_BIND_PORT` is the canonical setting. The Web Compose path also recognizes `ADMIN_WEB_PORT`.

---

# Python Configuration Helper

File:

[`runtime/scripts/multi-server-config.py`](../../runtime/scripts/multi-server-config.py)

## `plan`

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

JSON:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

`plan` does not modify files.

It derives defaults, generates profiles, and performs the global collision audit.

## `apply`

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

Dry-run:

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --dry-run
```

`apply` validates every profile from VM1 through the requested instance before changing files.

## `verify`

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

JSON:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --json
```

## Collision enforcement

The helper represents each managed item as an interval:

```text
Player/Game   start-end
IGW           start-end
PostgreSQL    port-port
RMQ Admin     port-port
RMQ Game      port-port
RMQ Game HTTP port-port
Text Router   port-port
Director      port-port
Admin Web     port-port
```

It then compares the complete interval set across all generated instances.

Protocol is deliberately ignored for collision purposes.

Any intersection is rejected.

That means a UDP range cannot numerically overlap a TCP scalar either.

This is intentional and matches the authoritative community policy in this document.

---

# Source-of-Truth Files

Future maintainers should revalidate this guide against:

- [`.env.example`](../../.env.example)
- [`install.sh`](../../install.sh)
- [`docker-compose.yml`](../../docker-compose.yml)
- [`docker-compose.web.yml`](../../docker-compose.web.yml)
- [`docker-compose.metrics.yml`](../../docker-compose.metrics.yml)
- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)
- [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh)
- [`runtime/scripts/start-server-overmap.sh`](../../runtime/scripts/start-server-overmap.sh)
- [`runtime/scripts/start-server-survival-1.sh`](../../runtime/scripts/start-server-survival-1.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)
- [`runtime/scripts/start-postgres.sh`](../../runtime/scripts/start-postgres.sh)
- [`runtime/scripts/start-text-router.sh`](../../runtime/scripts/start-text-router.sh)
- [`runtime/scripts/start-director.sh`](../../runtime/scripts/start-director.sh)
- [`runtime/scripts/network-addresses.sh`](../../runtime/scripts/network-addresses.sh)
- [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh)
- [`runtime/scripts/doctor.sh`](../../runtime/scripts/doctor.sh)
- [`runtime/scripts/multi-server-config.py`](../../runtime/scripts/multi-server-config.py)

---

# Maintainer Validation Notes

This guide was cross-checked against upstream `Red-Blink/dune-awakening-selfhost-docker` `main` at:

```text
7b7d8f1950a278e6431519841d5408cf04c582fb
```

At that baseline:

- service defaults are environment-backed through `runtime-env.sh`;
- `Port` and `IGWPort` are UserEngine-backed through `usersettings.py`;
- the manager exposes `Port` and `IGWPort` editing;
- game server processes use host networking in important runtime paths;
- the dynamic player and IGW planning pools extend through base `+33`;
- PostgreSQL, RMQ Admin, Text Router, and Director use loopback host publications in current startup scripts;
- RMQ Game and RMQ Game HTTP are distinct host-published endpoints;
- Server Gateway receives the advertised `SERVER_IP`, RMQ Game port, and RMQ Game HTTP port;
- NAT mode distinguishes the public advertised address from the local bind address;
- Web Console uses host networking and supports a configurable Admin Web port.

The community multi-server policy adds one additional invariant:

> **No managed numeric port or range may overlap another managed numeric port or range anywhere in the generated multi-VM deployment, regardless of protocol.**

If upstream defaults, bindings, or allocator behavior change, update this guide and `multi-server-config.py` together.

For upstream contribution/staging instructions, see:

[`MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md`](MULTI-SERVER-SINGLE-PUBLIC-IP-UPSTREAM-PR.md)
