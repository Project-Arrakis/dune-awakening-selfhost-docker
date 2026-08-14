# Running Multiple Dune: Awakening Servers Behind One Public IPv4

**Status:** Current | **Last Updated:** August 2026

This document is the operator guide and standard operating procedure (SOP) for running multiple independent `dune-awakening-selfhost-docker` battlegroups on one physical server while sharing one public IPv4 address.

The recommended architecture is **one isolated Linux VM per Dune battlegroup**. A hypervisor such as Proxmox VE, KVM/libvirt, VMware, or Hyper-V provides the isolation boundary; each VM runs its own Docker Engine and its own checkout of this repository.

The guide is source-driven. Port defaults, runtime bindings, advertised addresses, and configuration methods are derived from the repository rather than from generic Docker or game-server assumptions.

> **Validated source baseline**
>
> - Upstream repository: `Red-Blink/dune-awakening-selfhost-docker`
> - Upstream `main` commit validated for this guide: `7b7d8f1950a278e6431519841d5408cf04c582fb`
> - Staging fork: `yacketrj/dune-awakening-selfhost-docker`
>
> Re-run the validation steps in this SOP after upgrades. Port defaults and runtime behavior can change.

---

# Executive Summary

## Objective

A single public IPv4 address can support multiple independent Dune: Awakening self-hosted battlegroups when each battlegroup has:

1. its own isolated VM and LAN address;
2. its own Docker daemon and runtime state;
3. a distinct per-instance service-port profile;
4. a distinct public player/game UDP range;
5. distinct RabbitMQ Game and RabbitMQ Game HTTP public ports;
6. a distinct Admin Web port when the Web Console is reachable from outside the VM;
7. correct `SERVER_IP` and `SERVER_BIND_IP` values for NAT;
8. correct UserEngine `Port` and `IGWPort` values;
9. firewall and NAT rules matching the assigned profile;
10. working NAT reflection/hairpin behavior when the server must reach services through its own advertised public IP.

The physical topology is:

```text
                              Internet
                                 |
                          One Public IPv4
                                 |
                         Firewall / Router
                                 |
                  +--------------+--------------+
                  |                             |
          Proxmox / Hypervisor Host             |
                  |                             |
          +-------+--------+--------------------+
          |                |                    |
       DUNE-01          DUNE-02              DUNE-03
       VM #1            VM #2                VM #3
   192.168.68.127   192.168.68.128       192.168.68.129
       Docker           Docker               Docker
       Stack A          Stack B              Stack C
```

All VMs may advertise the **same public IPv4**. They are distinguished by protocol and destination port.

## Recommended deployment model

Use **one VM per battlegroup**.

Do not treat two checkouts inside one Linux network namespace as equivalent to two VMs. The runtime uses fixed container names, fixed Docker resources, host networking for game processes, and other shared host assumptions. VM isolation avoids those collision classes and is the cleanest community-supported architecture for multi-battlegroup hosting.

## Complete per-instance port namespace

This SOP intentionally assigns a unique profile to **every configurable service port listed below**, even where the current upstream runtime binds a service to loopback.

That policy has four benefits:

- every battlegroup has an unambiguous service identity;
- logs, packet captures, monitoring, and troubleshooting are easier to interpret;
- tools that consume host ports cannot accidentally target the wrong battlegroup;
- a future upstream binding change does not immediately introduce duplicate-port assumptions.

A unique port profile does **not** mean every port should be exposed to the Internet. WAN exposure is a separate decision covered later in this SOP.

## Standard profiles

The following profile reproduces the validated second-server configuration and extends the same offset policy to additional VMs.

| Function | VM1 / Instance 1 | VM2 / Instance 2 | VM3 / Instance 3 |
|---|---:|---:|---:|
| Player/game UDP base | `7777` | `7877` | `7977` |
| Player/game UDP pool | `7777-7810` | `7877-7910` | `7977-8010` |
| IGW UDP base | `7888` | `7988` | `8088` |
| IGW UDP pool | `7888-7921` | `7988-8021` | `8088-8121` |
| PostgreSQL TCP | `15432` | `16432` | `17432` |
| RMQ Admin TCP | `32573` | `33573` | `34573` |
| RMQ Game TCP | `31982` | `32982` | `33982` |
| RMQ Game HTTP TCP | `31983` | `32983` | `33983` |
| Text Router TCP | `5059` | `5159` | `5259` |
| Director TCP | `11717` | `12717` | `13717` |
| Admin Web TCP | `8088` | `8090` | `8092` |

The helper script included with this guide derives the stock defaults from the checked-out repository and generates these profiles automatically:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

## Configuration sources: do not confuse them

There are two different configuration paths.

### Service ports are `.env`-backed

The current runtime resolves these from environment variables with defaults in [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh):

```text
POSTGRES_PORT          15432
RMQ_ADMIN_PORT         32573
RMQ_GAME_PORT          31982
RMQ_GAME_HTTP_PORT     31983
TEXT_ROUTER_PORT       5059
DIRECTOR_PORT          11717
```

The Web Console uses `ADMIN_BIND_PORT`, default `8088`, from [`.env.example`](../../.env.example) and [`docker-compose.web.yml`](../../docker-compose.web.yml).

### Player and IGW bases are UserEngine settings

The authoritative game port settings are:

```ini
[URL]
Port=7777
IGWPort=7888
```

They are defined by [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini) and the UserEngine schema in [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py).

On current upstream, the runtime resolves player/IGW bases through `usersettings.py`, not by trusting a `CLIENT_PORT_BASE=` or `IGW_PORT_BASE=` line in `.env` alone.

Use either:

- the manager UserEngine editor; or
- `usersettings.py engine-set`.

This guide's helper performs both the `.env` work and the authoritative UserEngine updates.

## Public vs bind address

For a NAT-hosted server:

```text
SERVER_IP       = public WAN IPv4 advertised to players/services
SERVER_BIND_IP  = VM's local/LAN IPv4 where game sockets bind
```

Example:

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
```

This behavior is implemented by [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh), which preserves the local bind address while using an external-address override for the public advertised address.

## Public endpoint minimum

For normal public game operation, the repository's public-hosting flow explicitly accounts for:

- RMQ Game TCP;
- RMQ Game HTTP TCP;
- the configured player/game UDP range.

See [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh), [`runtime/scripts/doctor.sh`](../../runtime/scripts/doctor.sh), [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh), and [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh).

The Admin Web port must also be unique when the Web Console is intentionally reachable through the shared public IPv4.

Do not expose PostgreSQL, RMQ Admin, Text Router, Director, Prometheus, or other control-plane services to the WAN simply because this SOP assigns them unique ports.

## Hairpin NAT / NAT reflection is important

[`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh) launches the Server Gateway with:

```text
--RMQGameHostname=$SERVER_IP
--RMQGamePort=<configured RMQ game port>
--RMQGameHttpPort=<configured RMQ game HTTP port>
```

For a home or datacenter NAT deployment where `SERVER_IP` is the router's public IPv4, the VM may need to reach its own public address and be translated back to itself.

Your router/firewall should therefore support **NAT reflection / hairpin NAT / NAT loopback**, or an equivalent routing design must make those public endpoint tuples reachable from the server-side network.

---

# Detailed Standard Operating Procedure

## SOP scope

This SOP assumes:

- one physical server or cluster node;
- one public IPv4 address;
- two or more Linux VMs;
- one independent Dune battlegroup per VM;
- a routed or bridged LAN behind a firewall/router;
- Docker Engine inside each VM;
- public Internet players.

The examples use:

```text
Public IPv4:        203.0.113.50       example only
DUNE-01 VM:         192.168.68.127
DUNE-02 VM:         192.168.68.128
DUNE-03 VM:         192.168.68.129
```

Replace all example addresses with your actual network values.

---

## Phase 0 - Change-control preparation

Before modifying a running deployment:

1. identify each battlegroup and VM;
2. record the current `.env`;
3. record current UserEngine values;
4. record current router/NAT rules;
5. ensure you have a current VM snapshot or configuration backup;
6. schedule a maintenance window if players are active;
7. confirm console access to the hypervisor and router in case remote access is disrupted.

On each VM:

```bash
cd /path/to/dune-awakening-selfhost-docker

cp -a .env ".env.pre-multiserver.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 runtime/scripts/usersettings.py engine-values
```

Record at minimum:

```text
port
igw_port
```

Also capture:

```bash
docker ps
ss -lntup
```

---

## Phase 1 - Validate the checked-out repository defaults

Do not assume the defaults in this document are unchanged after an upgrade.

Run:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

The helper parses the checked-out repository for:

- service defaults in `runtime/scripts/runtime-env.sh`;
- `Port` and `IGWPort` defaults in `runtime/scripts/usersettings.py`;
- the dynamic pool maximum offset in `runtime/scripts/spawn-server.sh`;
- the Web Console default in `.env.example`.

If those source patterns change, the helper stops instead of silently applying an obsolete profile.

For the validated upstream baseline, the expected first-instance defaults are:

```text
Player/game base   7777
Player/game pool   7777-7810
IGW base           7888
IGW pool           7888-7921
PostgreSQL         15432/TCP
RMQ Admin          32573/TCP
RMQ Game           31982/TCP
RMQ Game HTTP      31983/TCP
Text Router        5059/TCP
Director           11717/TCP
Admin Web          8088/TCP
```

If the helper reports different defaults, stop and review the current source before following hard-coded examples from this document.

---

## Phase 2 - Build the VM isolation layer

### 2.1 Create one VM per battlegroup

For Proxmox, create separate Linux VMs such as:

```text
DUNE-01
DUNE-02
DUNE-03
```

Each VM should have:

- its own virtual NIC;
- its own static or DHCP-reserved LAN IPv4;
- its own filesystem;
- its own Docker daemon;
- its own repository checkout;
- its own `.env` and `runtime/` state;
- sufficient CPU and RAM for its intended maps.

### 2.2 Use a bridged network where practical

A simple bridged design makes each VM a normal LAN host:

```text
vmbr0
  |
  +-- DUNE-01 192.168.68.127
  +-- DUNE-02 192.168.68.128
  +-- DUNE-03 192.168.68.129
```

This simplifies port forwarding and troubleshooting compared with adding another NAT layer inside the hypervisor.

### 2.3 Reserve VM addresses

Do not allow the VM addresses to drift after router port forwarding is configured.

Use either:

- static addressing inside the VM; or
- DHCP reservations keyed to each VM NIC MAC address.

Validate from each VM:

```bash
ip -4 addr
ip route
```

Then verify Internet egress:

```bash
curl -4 https://api.ipify.org
```

All VMs behind the same router should normally report the same public IPv4.

---

## Phase 3 - Install one Dune stack per VM

On each VM, install the upstream project using its normal installation process.

Do not clone one already-running VM after it has generated battlegroup-specific state unless you intentionally reset or regenerate all identity/state that should be unique.

Each VM should have its own checkout, for example:

```text
/opt/dune-awakening-selfhost-docker
```

or an equivalent operator-owned path.

Complete normal first-time initialization for each battlegroup according to the project README and installer.

This SOP does not change Funcom token entitlement or licensing requirements. Use valid self-host credentials as required by Funcom and the upstream project.

---

## Phase 4 - Assign the instance number

Choose a stable instance number for every VM.

Example:

```text
DUNE-01 -> instance 1
DUNE-02 -> instance 2
DUNE-03 -> instance 3
```

Do not renumber casually after deployment. The instance number determines the standard port profile.

Generate the plan from any current checkout:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

For machine-readable automation:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

---

## Phase 5 - Stop the stack before changing network identity

Changing service ports while the old containers remain active makes validation ambiguous and can create transient conflicts.

Use the project's normal stop command before applying a production change.

Then verify no active Dune game/service containers remain unexpectedly:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

The helper refuses to apply while Dune containers are running unless `--allow-running` is explicitly supplied.

`--allow-running` should be treated as a staging option only. Running processes retain their old listeners until restarted.

---

## Phase 6 - Configure each VM

There are two supported operator workflows in this guide:

1. automated helper - recommended;
2. manual configuration - useful for auditing or unsupported environments.

---

## Phase 6A - Automated configuration with `multi-server-config.py`

The helper is located at:

```text
runtime/scripts/multi-server-config.py
```

### 6A.1 Dry-run first

For VM2:

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --dry-run
```

Review every value before applying.

Expected VM2 profile:

```text
Player/game UDP   7877-7910
IGW UDP           7988-8021
PostgreSQL TCP    16432
RMQ Admin TCP     33573
RMQ Game TCP      32982
RMQ Game HTTP     32983
Text Router TCP   5159
Director TCP      12717
Admin Web TCP     8090
```

### 6A.2 Apply the profile

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

The helper performs the following operations:

1. derives current defaults from repository source;
2. computes the instance profile;
3. validates all ports are in range;
4. validates the player range does not overlap the IGW range;
5. checks for running Dune containers;
6. creates a timestamped configuration backup;
7. updates or adds the relevant `.env` values;
8. writes `IGWPort` through `usersettings.py`;
9. writes `Port` through `usersettings.py`;
10. materializes current runtime UserEngine/UserGame files;
11. prints the NAT rules required for the public endpoint set;
12. does **not** restart containers automatically.

Backups are stored under:

```text
runtime/backups/multi-server-config-<UTC timestamp>/
```

The helper backs up any existing:

```text
.env
runtime/generated/usersettings.json
runtime/generated/gameplay-profile.ini
```

### 6A.3 Why the helper changes IGW first

For VM2, the desired player base is `7877`, while the stock IGW pool begins at `7888`.

If the player base were moved first while IGW were still on its stock value, the temporary configuration could overlap:

```text
new player pool: 7877-7910
old IGW pool:    7888-7921
```

The repository's UserEngine validation is expected to reject an invalid overlap.

The helper therefore changes:

```text
IGWPort first
Port second
```

which avoids the transient invalid state.

### 6A.4 Verify the saved profile

For VM2:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

For automation:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --json
```

---

## Phase 6B - Manual configuration

Use this path when auditing the helper or when you need to perform the change without it.

### 6B.1 VM1

VM1 may use the upstream defaults:

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

# Metadata/documentation compatibility; authoritative game values are UserEngine.
CLIENT_PORT_BASE=7777
IGW_PORT_BASE=7888
```

Authoritative UserEngine values:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 7888
python3 runtime/scripts/usersettings.py engine-set port 7777
python3 runtime/scripts/usersettings.py materialize-current
```

### 6B.2 VM2

VM2 standard profile:

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128

POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=8090
ADMIN_WEB_PORT=8090

# Metadata/documentation compatibility; authoritative game values are UserEngine.
CLIENT_PORT_BASE=7877
IGW_PORT_BASE=7988
```

Then set UserEngine in this order:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 7988
python3 runtime/scripts/usersettings.py engine-set port 7877
python3 runtime/scripts/usersettings.py materialize-current
```

### 6B.3 VM3

VM3 standard profile:

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.129

POSTGRES_PORT=17432
RMQ_ADMIN_PORT=34573
RMQ_GAME_PORT=33982
RMQ_GAME_HTTP_PORT=33983
TEXT_ROUTER_PORT=5259
DIRECTOR_PORT=13717
ADMIN_BIND_PORT=8092
ADMIN_WEB_PORT=8092

CLIENT_PORT_BASE=7977
IGW_PORT_BASE=8088
```

Then:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 8088
python3 runtime/scripts/usersettings.py engine-set port 7977
python3 runtime/scripts/usersettings.py materialize-current
```

### 6B.4 Do not blindly append duplicate `.env` keys

A command such as:

```bash
cat >> .env <<'EOF'
...
EOF
```

is safe only when those keys do not already exist.

Before manually appending, check:

```bash
grep -nE '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

If keys already exist, edit or replace them rather than creating multiple active definitions.

The helper performs an update-or-insert operation and removes duplicate active definitions for the keys it manages.

---

## Phase 7 - Manager-based UserEngine configuration

If you prefer the interactive manager instead of `usersettings.py`, open:

```bash
runtime/scripts/manager.sh
```

Navigate to the UserEngine global-default editor.

The manager exposes:

```text
Port
IGWPort
```

These menu entries are implemented in [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh).

For VM2 set:

```text
Port:    7877
IGWPort: 7988
```

For VM3 set:

```text
Port:    7977
IGWPort: 8088
```

Running map containers keep their previous values until restarted. The manager itself reports that behavior after a UserEngine update.

---

## Phase 8 - Configure public NAT / port forwarding

### 8.1 Required public game endpoints

For public hosting, forward the unique instance-specific values for:

- RMQ Game TCP;
- RMQ Game HTTP TCP;
- player/game UDP range.

If the Web Console is intentionally exposed publicly, forward its unique Admin Web TCP port as well.

### 8.2 VM1 forwarding

```text
TCP 31982       -> 192.168.68.127:31982
TCP 31983       -> 192.168.68.127:31983
UDP 7777-7810   -> 192.168.68.127:7777-7810
TCP 8088        -> 192.168.68.127:8088     optional Web Console
```

### 8.3 VM2 forwarding

```text
TCP 32982       -> 192.168.68.128:32982
TCP 32983       -> 192.168.68.128:32983
UDP 7877-7910   -> 192.168.68.128:7877-7910
TCP 8090        -> 192.168.68.128:8090     optional Web Console
```

### 8.4 VM3 forwarding

```text
TCP 33982       -> 192.168.68.129:33982
TCP 33983       -> 192.168.68.129:33983
UDP 7977-8010   -> 192.168.68.129:7977-8010
TCP 8092        -> 192.168.68.129:8092     optional Web Console
```

### 8.5 Prefer 1:1 port translation

Use the same external and internal port number wherever possible:

```text
PUBLIC:32982 -> VM2:32982
```

rather than:

```text
PUBLIC:32982 -> VM2:31982
```

The runtime passes configured port numbers through service registration and game/runtime state. Keeping public and internal ports identical removes an entire class of advertised-port mismatches.

---

## Phase 9 - Do not forward control-plane ports by default

The standard profile also changes:

```text
PostgreSQL
RMQ Admin
Text Router
Director
```

Current upstream starts several of these using `127.0.0.1` host bindings.

Examples:

- PostgreSQL is published as `127.0.0.1:${POSTGRES_PORT}:5432` in [`start-postgres.sh`](../../runtime/scripts/start-postgres.sh).
- RMQ Admin is published on loopback in [`start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh).
- Director is published on loopback in [`start-director.sh`](../../runtime/scripts/start-director.sh).
- Text Router is published on loopback in [`start-text-router.sh`](../../runtime/scripts/start-text-router.sh).

Therefore a normal router port forward to the VM LAN IP does not automatically make those loopback listeners remotely reachable.

This SOP still assigns them unique per-instance values for a consistent service namespace, but **do not rebind or publish them to the Internet unless you have a specific, reviewed requirement**.

PostgreSQL and internal control-plane interfaces should normally remain private.

---

## Phase 10 - Web Console access

The Web Console runs with host networking and binds the configured Admin Web port. See [`docker-compose.web.yml`](../../docker-compose.web.yml).

The upstream Compose file also mounts the Docker socket and explicitly warns that the container has broad control over the host Docker daemon.

For that reason, the preferred operational order is:

1. LAN-only access;
2. VPN access;
3. authenticated reverse proxy with TLS and strict administrative access controls;
4. direct public port forwarding only when necessary and explicitly secured.

If direct public forwarding is used, every VM must have a distinct public Admin Web port.

Example:

```text
203.0.113.50:8088 -> DUNE-01
203.0.113.50:8090 -> DUNE-02
203.0.113.50:8092 -> DUNE-03
```

---

## Phase 11 - Configure VM firewall rules

The exact firewall product is operator-specific. The following examples use UFW syntax.

### VM1

```bash
sudo ufw allow 31982/tcp
sudo ufw allow 31983/tcp
sudo ufw allow 7777:7810/udp
```

If Web Console access is required from a trusted management subnet:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 8088 proto tcp
```

### VM2

```bash
sudo ufw allow 32982/tcp
sudo ufw allow 32983/tcp
sudo ufw allow 7877:7910/udp
```

Optional management-only Web Console:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 8090 proto tcp
```

### VM3

```bash
sudo ufw allow 33982/tcp
sudo ufw allow 33983/tcp
sudo ufw allow 7977:8010/udp
```

Optional management-only Web Console:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 8092 proto tcp
```

Do not add WAN firewall rules for PostgreSQL or other internal control-plane listeners without a defined requirement.

---

## Phase 12 - Validate NAT reflection / hairpin behavior

This is a critical validation for home and SMB router deployments.

From VM2, test the public address using VM2's configured public RMQ ports:

```bash
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983
```

From VM1:

```bash
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983
```

A successful TCP path does not prove application-layer authentication, but it proves that the VM can reach the public tuple and be translated back to the correct internal VM.

If this fails while an external Internet host can connect, investigate:

- router NAT reflection / NAT loopback;
- split routing;
- local firewall rules;
- policy routing;
- ISP or gateway equipment behavior.

The reason this matters is visible in [`start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh): the gateway is given the public `SERVER_IP` together with the configured RMQ Game and RMQ Game HTTP ports.

---

## Phase 13 - Start the stack

After `.env`, UserEngine, VM firewall, and router/NAT configuration are complete, start the Dune stack using the normal project command.

Do not validate only one map. The game-port allocator assigns ports across map/server instances, so validation should include the normal always-on maps and any additional configured maps that may allocate dynamic ports.

---

## Phase 14 - Validate configuration state

### 14.1 Run the helper verifier

VM2 example:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

### 14.2 Verify `.env`

```bash
grep -E '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

VM2 should show:

```text
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=8090
ADMIN_WEB_PORT=8090
CLIENT_PORT_BASE=7877
IGW_PORT_BASE=7988
```

### 14.3 Verify authoritative UserEngine values

```bash
python3 runtime/scripts/usersettings.py engine-values | grep -E '^(port|igw_port)'
```

VM2 expected:

```text
port        7877
igw_port    7988
```

### 14.4 Inspect generated UserEngine files

Locate active runtime files:

```bash
find runtime/game -path '*/Saved/UserSettings/UserEngine.ini' -print
```

Inspect their `[URL]` section:

```bash
grep -RniE '^\[URL\]|^Port=|^IGWPort=' runtime/game/*/Saved/UserSettings/UserEngine.ini
```

### 14.5 Inspect sockets

```bash
ss -lntup
```

For VM2, look for the configured service ports and active UDP game/IGW listeners.

### 14.6 Inspect containers

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

### 14.7 Run project diagnostics

```bash
dune doctor
```

The current `doctor.sh` resolves the configured service ports and checks key TCP/UDP listeners. It also prints the public-hosting reminder for the configured RMQ ports and UDP game ranges.

Then run the normal readiness check used by your deployment, for example:

```bash
dune ready
```

---

## Phase 15 - Validate game and IGW address registration

The runtime deliberately separates player-facing and server-to-server addresses.

[`runtime/scripts/network-addresses.sh`](../../runtime/scripts/network-addresses.sh) reconciles:

```text
game_addr -> advertised/public game address
igw_addr  -> IGW/local bind address
```

Check current state:

```bash
runtime/scripts/network-addresses.sh status
```

For a NAT deployment, confirm:

- game addresses reflect the public advertised IP as intended;
- IGW addresses reflect the expected local/bind address;
- game ports match the assigned instance player range;
- IGW ports match the assigned instance IGW range.

This distinction is why the standard profile can have numerical overlap between another VM's IGW range and a public player range: the VMs are isolated, and IGW is a server-side path rather than the shared public player endpoint set.

---

## Phase 16 - External validation

Validation from inside the LAN is not enough.

Use a host genuinely outside the server network, such as:

- a cloud VM;
- a laptop on a separate Internet connection;
- a mobile hotspot;
- another remote site.

Test RMQ TCP reachability:

```bash
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983
```

If Web Console is intentionally public:

```bash
curl -I http://203.0.113.50:8088/
curl -I http://203.0.113.50:8090/
```

For player UDP, the most authoritative validation is an actual game client discovering, joining, and traveling through the server topology.

Generic UDP probes can be useful for packet capture, but absence of an application response does not necessarily prove a UDP port is closed.

---

## Phase 17 - Packet-capture validation

When troubleshooting, packet captures are often faster than repeatedly changing configuration.

On VM2:

```bash
sudo tcpdump -ni any 'tcp port 32982 or tcp port 32983 or udp portrange 7877-7910 or udp portrange 7988-8021'
```

On VM1:

```bash
sudo tcpdump -ni any 'tcp port 31982 or tcp port 31983 or udp portrange 7777-7810 or udp portrange 7888-7921'
```

Use captures to answer specific questions:

- does Internet traffic reach the correct VM?;
- does the game process reply?;
- is a request reaching VM1 when it should reach VM2?;
- does hairpin traffic leave the VM and return?;
- are player packets targeting the configured base/range?;
- are IGW packets using the expected local address and port?;
- is a firewall dropping traffic before Docker/game processes see it?.

---

## Phase 18 - Monitoring and observability ports

The repository also contains an optional metrics stack.

For example, [`docker-compose.metrics.yml`](../../docker-compose.metrics.yml) publishes Prometheus on loopback using a configurable port with a default of `9090`.

Treat observability as a separate management plane.

Recommended practice:

- keep Prometheus private;
- keep exporters private;
- expose Grafana only through a trusted management path;
- use VPN, reverse proxy, SSO, or equivalent controls;
- if multiple VM-local dashboards are exposed through one public IPv4, assign unique public ports or unique reverse-proxy hostnames.

Do not mix the observability port plan with the game's required public endpoint plan.

---

## Phase 19 - Security requirements

### 19.1 Do not expose PostgreSQL directly

PostgreSQL contains authoritative game state. Keep it bound to loopback/private networking unless a reviewed operational requirement states otherwise.

### 19.2 Protect the Web Console

The Web Console mounts the Docker socket. Compromise of the console can become compromise of the VM's Docker host.

Use:

- strong authentication;
- TLS for remote access;
- restricted source networks;
- VPN where practical;
- regular patching;
- no unnecessary WAN exposure.

### 19.3 Keep secrets out of Git

Do not commit:

- Funcom self-host tokens;
- generated secrets;
- admin passwords;
- private keys;
- database credentials.

### 19.4 Default-deny inbound policy

The ideal public firewall policy allows only the public endpoints actually needed for the instance.

Everything else remains denied or management-network-only.

---

## Phase 20 - Capacity planning

Port separation only solves network identity. It does not solve resource contention.

For each VM account for:

- game-server memory reservations;
- map count;
- number of Sietch dimensions;
- Deep Desert configuration;
- CPU scheduling latency;
- storage IOPS;
- PostgreSQL activity;
- Docker image/cache size;
- observability overhead;
- backup activity;
- host reserve for the hypervisor.

Do not allocate 100% of physical RAM to guest VMs.

Leave sufficient hypervisor and filesystem cache headroom, and avoid CPU overcommit that introduces scheduling jitter into latency-sensitive game processes.

---

## Phase 21 - Upgrade procedure

After pulling an upstream update, do not assume the old port model remains valid.

Before restarting production:

```bash
git pull
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

The helper is intentionally source-aware. If it can no longer derive the service defaults or pool sizes, treat that as a required review point rather than bypassing the error.

Then inspect:

```bash
git diff HEAD@{1} -- \
  .env.example \
  docker-compose*.yml \
  runtime/scripts/runtime-env.sh \
  runtime/scripts/spawn-server.sh \
  runtime/scripts/start-rabbitmq.sh \
  runtime/scripts/start-postgres.sh \
  runtime/scripts/start-text-router.sh \
  runtime/scripts/start-director.sh \
  runtime/scripts/start-server-gateway.sh \
  runtime/scripts/network-addresses.sh \
  runtime/scripts/usersettings.py \
  runtime/defaults/UserEngine.ini
```

Revalidate NAT/firewall rules if any listener, default, or advertised endpoint changes.

---

## Phase 22 - Rollback procedure

If the change fails, stop the Dune stack before restoring configuration.

When the helper was used, find the most recent backup:

```bash
ls -1dt runtime/backups/multi-server-config-* | head
```

A backup may contain:

```text
.env
runtime/generated/usersettings.json
runtime/generated/gameplay-profile.ini
```

Restore only after confirming the backup corresponds to the intended pre-change state.

Example pattern:

```bash
BACKUP_DIR="runtime/backups/multi-server-config-YYYYMMDDTHHMMSSZ"

cp -a "$BACKUP_DIR/.env" .env
```

Restore generated settings files when present, preserving their relative paths.

Then rematerialize:

```bash
python3 runtime/scripts/usersettings.py materialize-current
```

Restore the previous firewall and NAT rules, restart the stack, and run:

```bash
dune doctor
dune ready
```

---

# Troubleshooting Matrix

| Symptom | Likely cause | Checks |
|---|---|---|
| VM2 appears in server list but players cannot join | Wrong VM2 UDP NAT range or wrong UserEngine `Port` | `usersettings.py engine-values`, router rules, `tcpdump` |
| VM2 still listens on `7777` | `.env` changed but authoritative UserEngine `Port` was not changed | `engine-values`, generated `UserEngine.ini` |
| `engine-set port 7877` fails with overlap | IGW still on default `7888` while new player pool overlaps it | set `igw_port 7988` first |
| Gateway cannot reach RMQ using public IP | hairpin/NAT reflection missing | `nc` from VM to public RMQ tuple, router NAT settings |
| VM1 works, VM2 RMQ fails | router still forwards VM2 public port to VM1 or no VM2 rule exists | NAT rule destination, packet capture |
| Web Console VM2 opens VM1 | same public Admin Web port forwarded twice or reverse proxy target wrong | router/reverse-proxy config |
| `dune doctor` reports wrong service port | `.env` override missing, duplicate, or not sourced | `grep` `.env`, runtime resolver defaults |
| game/IGW addresses contain wrong IP | `SERVER_IP`/`SERVER_BIND_IP` incorrect | `network-addresses.sh status` |
| game sockets try to bind public IP on NAT host | bind/public address configuration or `ip_nonlocal_bind` issue | `dune doctor`, `runtime-env.sh` NAT guard |
| only LAN clients work | missing public NAT/firewall or advertised public IP wrong | external test, `SERVER_IP`, router rules |
| second VM starts but dynamic maps fail to allocate ports | player/IGW pool overlap or insufficient free ports | `spawn-server.sh` allocation logs, `ss -lnup` |
| helper refuses to derive defaults | upstream source layout changed | inspect listed source-of-truth files before updating helper |
| helper refuses because containers are running | production safety guard | stop stack, or use `--allow-running` only to stage changes |

---

# Port Source and Runtime Behavior Reference

## Player/game `Port`

Default:

```text
7777
```

Authoritative sources:

- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)
- [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh)

The UserEngine comments state that `Port` is the starting port used for players and subsequent servers consume the next available ports.

The current dynamic allocator checks through `CLIENT_PORT_BASE + 33`, producing a 34-port pool for the validated baseline.

## IGW `IGWPort`

Default:

```text
7888
```

Sources:

- [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini)
- [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py)
- [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh)
- [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh)

The UserEngine comments identify this as the starting server-to-server port sequence and require it not to intersect the player `Port` range.

## PostgreSQL

Default host port:

```text
15432/TCP
```

Source:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-postgres.sh`](../../runtime/scripts/start-postgres.sh)

Current host publish:

```text
127.0.0.1:${POSTGRES_PORT}:5432
```

Game processes using host networking connect to the configured host port.

## RMQ Admin

Default:

```text
32573/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)

Current publish is loopback-only.

## RMQ Game

Default:

```text
31982/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)

RMQ Game is published on the host and the Server Gateway is launched with the configured public `SERVER_IP` and RMQ Game port.

## RMQ Game HTTP

Default:

```text
31983/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh)
- [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh)
- [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh)

This is a distinct endpoint from RMQ Game and must receive its own per-instance public mapping.

## Text Router

Default:

```text
5059/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-text-router.sh`](../../runtime/scripts/start-text-router.sh)

The current host publish is loopback-only.

## Director

Default:

```text
11717/TCP
```

Sources:

- [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh)
- [`runtime/scripts/start-director.sh`](../../runtime/scripts/start-director.sh)
- game-server start/spawn scripts

The current host publish is loopback-only, and host-network game processes are launched with the configured Director host port.

## Admin Web

Default:

```text
8088/TCP
```

Sources:

- [`.env.example`](../../.env.example)
- [`install.sh`](../../install.sh)
- [`docker-compose.web.yml`](../../docker-compose.web.yml)
- [`console/api/src/config.js`](../../console/api/src/config.js)

`ADMIN_BIND_PORT` is the canonical setting. `docker-compose.web.yml` also recognizes `ADMIN_WEB_PORT` as an override alias. This SOP keeps both aligned in the automated profile.

---

# Why the Full VM2 Port Block Makes Sense

A proven second-instance profile is:

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

The important nuance is that current upstream does **not** use `.env` as the authoritative source for the first two game settings.

Therefore the complete implementation is:

```text
.env / service namespace
  CLIENT_PORT_BASE=7877          documentation/console compatibility
  IGW_PORT_BASE=7988             documentation/console compatibility
  POSTGRES_PORT=16432
  RMQ_ADMIN_PORT=33573
  RMQ_GAME_PORT=32982
  RMQ_GAME_HTTP_PORT=32983
  TEXT_ROUTER_PORT=5159
  DIRECTOR_PORT=12717
  ADMIN_BIND_PORT=8090
  ADMIN_WEB_PORT=8090

UserEngine / authoritative game network settings
  Port=7877
  IGWPort=7988
```

The included helper applies exactly that model.

---

# Automation Helper Reference

## File

[`runtime/scripts/multi-server-config.py`](../../runtime/scripts/multi-server-config.py)

## `plan`

Generate standard profiles without modifying files:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

JSON:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

## `apply`

Apply one profile to the current VM:

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

## `verify`

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

## What the helper does not do

The helper does not:

- create VMs;
- configure Proxmox;
- configure the router/firewall;
- modify Funcom credentials;
- generate or copy secrets;
- expose internal services;
- restart the running Dune stack;
- SSH into other VMs.

It is intentionally a **per-VM configuration primitive**.

That makes it suitable for manual use and for higher-level orchestration through Ansible, SSH, Terraform provisioners, cloud-init, or another operator-controlled system without embedding remote credentials in this repository.

---

# Example Three-VM Deployment Checklist

## DUNE-01

```text
LAN IP:        192.168.68.127
Instance:      1
Game:          UDP 7777-7810
IGW:           UDP 7888-7921
Postgres:      TCP 15432
RMQ Admin:     TCP 32573
RMQ Game:      TCP 31982
RMQ Game HTTP: TCP 31983
Text Router:   TCP 5059
Director:      TCP 11717
Admin Web:     TCP 8088
```

Public forward:

```text
31982/TCP
31983/TCP
7777-7810/UDP
8088/TCP optional
```

## DUNE-02

```text
LAN IP:        192.168.68.128
Instance:      2
Game:          UDP 7877-7910
IGW:           UDP 7988-8021
Postgres:      TCP 16432
RMQ Admin:     TCP 33573
RMQ Game:      TCP 32982
RMQ Game HTTP: TCP 32983
Text Router:   TCP 5159
Director:      TCP 12717
Admin Web:     TCP 8090
```

Public forward:

```text
32982/TCP
32983/TCP
7877-7910/UDP
8090/TCP optional
```

## DUNE-03

```text
LAN IP:        192.168.68.129
Instance:      3
Game:          UDP 7977-8010
IGW:           UDP 8088-8121
Postgres:      TCP 17432
RMQ Admin:     TCP 34573
RMQ Game:      TCP 33982
RMQ Game HTTP: TCP 33983
Text Router:   TCP 5259
Director:      TCP 13717
Admin Web:     TCP 8092
```

Public forward:

```text
33982/TCP
33983/TCP
7977-8010/UDP
8092/TCP optional
```

---

# Source-of-Truth Files

Future maintainers should revalidate this document against these files before changing port guidance:

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

This guide was cross-checked against upstream `Red-Blink/dune-awakening-selfhost-docker` `main` at commit:

```text
7b7d8f1950a278e6431519841d5408cf04c582fb
```

At that baseline:

- service defaults are environment-backed through `runtime-env.sh`;
- `Port` and `IGWPort` are UserEngine-backed through `usersettings.py`;
- the manager exposes `Port` and `IGWPort` editing;
- game server containers use host networking;
- the dynamic player and IGW pools extend through base `+33`;
- PostgreSQL, RMQ Admin, Text Router, and Director use loopback host publications in their startup scripts;
- RMQ Game and RMQ Game HTTP are distinct host-published endpoints;
- Server Gateway receives the advertised `SERVER_IP`, RMQ Game port, and RMQ Game HTTP port;
- NAT mode distinguishes public advertised address from local bind address;
- Web Console runs with host networking and supports a configurable Admin Web port.

If any of those statements stop being true, update this document and the automation helper together.
