# Running Multiple Dune: Awakening Servers Behind One Public IPv4

**Status:** Current | **Last Updated:** August 2026

This guide describes how to run multiple independent `dune-awakening-selfhost-docker` battlegroups on one physical server while sharing a single public IPv4 address.

The recommended architecture is **one isolated Linux VM per Dune battlegroup**. A hypervisor such as Proxmox VE, KVM/libvirt, VMware, Hyper-V, or another platform provides the isolation boundary; each VM runs its own Docker Engine and its own checkout of this repository.

The guide is intentionally source-driven. Port defaults and runtime behavior are derived from the repository rather than from assumptions about Docker or generic game-server hosting.

> **Validated source baseline**
>
> - Upstream: `Red-Blink/dune-awakening-selfhost-docker` `main` at commit `7b7d8f1950a278e6431519841d5408cf04c582fb` (2026-08-13)
> - Staging fork: `yacketrj/dune-awakening-selfhost-docker` `main` at commit `391516ede64983b983e0eaed5d2fedac0ebba9e7`
>
> Re-check the [Source-of-truth files](#source-of-truth-files) after upgrades because ports, bindings, and generated runtime behavior can change.

---

## 1. What this guide means by “multiple servers on one host”

In this document:

- **Physical host** means the actual bare-metal machine running the hypervisor.
- **VM** means an isolated Linux virtual machine with its own IP address, network namespace, Docker daemon, filesystem, and Dune installation.
- **Dune server / battlegroup** means one complete `dune-awakening-selfhost-docker` deployment, including PostgreSQL, RabbitMQ, Text Router, Director, Server Gateway, map servers, and optionally the Web Console and metrics components.
- **Public IP** means the single Internet-routable IPv4 address shared by all of the VMs.
- **LAN IP / bind IP** means the private address assigned to an individual VM, for example `192.168.68.127`.

The topology covered here is:

```text
                              Internet
                                  |
                        one public IPv4 address
                                  |
                        Router / Firewall / NAT
                                  |
                    +-------------+-------------+
                    |             |             |
                    v             v             v
              DUNE-VM-01     DUNE-VM-02     DUNE-VM-03
             192.168.68.127 192.168.68.128 192.168.68.129
                    |             |             |
              Docker Engine   Docker Engine   Docker Engine
                    |             |             |
              Battlegroup A   Battlegroup B   Battlegroup C
```

All VMs may use the **same `SERVER_IP` public address**. They are distinguished by unique protocol/port tuples and by their separate battlegroup identities.

### Why separate VMs are strongly recommended

The current runtime is designed around one complete stack per Docker host/network namespace. Several resources have fixed names, including containers such as `dune-postgres`, `dune-rmq-admin`, `dune-rmq-game`, `dune-text-router`, and `dune-director`. The runtime also creates `dune-net` and `dune-postgres-data`, and game processes use host networking. RabbitMQ additionally publishes a fixed loopback management listener on `127.0.0.1:15672`.

For those reasons, **this guide does not recommend running multiple complete battlegroups inside the same Linux VM or Docker daemon**. Doing so requires a broader namespace/refactoring effort than simply changing ports.

VM isolation avoids those collisions while still allowing all VMs to share the same physical CPU, RAM, storage, NICs, and public IPv4 address.

---

## 2. Core design rule

A single IPv4 address can host many independent services because a network endpoint is not just an IP address. The effective endpoint is:

```text
protocol + destination IP + destination port
```

For example, these are distinct Internet endpoints even though the IP is identical:

```text
PUBLIC_IP:31982/TCP  -> DUNE-VM-01 RabbitMQ game
PUBLIC_IP:32982/TCP  -> DUNE-VM-02 RabbitMQ game
PUBLIC_IP:33982/TCP  -> DUNE-VM-03 RabbitMQ game
```

The same principle applies to the player UDP ranges and any Web Console ports intentionally exposed through the firewall.

The important operational rule is:

> **Every Dune VM receives its own complete port profile. Do not clone a VM and leave the second battlegroup on the first battlegroup's public endpoint set.**

Even when a listener is loopback-only and VM isolation would technically allow the same numeric port on multiple VMs, this guide recommends assigning a distinct profile to each battlegroup. This makes configuration, packet captures, firewall policy, logs, monitoring, future service exposure, and support significantly less ambiguous.

---

## 3. Source-derived default port inventory for one server

The runtime service-port defaults are defined by `runtime/scripts/runtime-env.sh`:

```bash
resolve_postgres_port()      { port_env_value POSTGRES_PORT 15432; }
resolve_rmq_admin_port()     { port_env_value RMQ_ADMIN_PORT 32573; }
resolve_rmq_game_port()      { port_env_value RMQ_GAME_PORT 31982; }
resolve_rmq_game_http_port() { port_env_value RMQ_GAME_HTTP_PORT 31983; }
resolve_text_router_port()   { port_env_value TEXT_ROUTER_PORT 5059; }
resolve_director_port()      { port_env_value DIRECTOR_PORT 11717; }
```

Player and IGW ports come from UserEngine settings rather than the service-port resolver. `runtime/defaults/UserEngine.ini` defines:

```ini
[URL]
Port=7777
IGWPort=7888
```

The comments in that file are important: `Port` and `IGWPort` are **starting ports**, and additional game-server processes use subsequent ports in sequence. The runtime currently allocates through `base + 33` for dynamic map processes.

| Component | Default | Protocol | Binding / purpose | Public NAT? |
|---|---:|---|---|---|
| Player/game base | `7777` | UDP | Starting player-facing game port | **Yes** |
| Player/game pool | `7777-7810` | UDP | `Port` through `Port + 33` | **Yes** |
| IGW base | `7888` | UDP | Starting server-to-server port | **No; keep private** |
| IGW pool | `7888-7921` | UDP | `IGWPort` through `IGWPort + 33` | **No; keep private** |
| PostgreSQL | `15432` | TCP | Host loopback -> container `5432` | No |
| RabbitMQ Admin | `32573` | TCP | Host loopback -> container `5672` | No |
| RabbitMQ Game | `31982` | TCP/TLS | Game RabbitMQ externally bound listener | **Yes** |
| RabbitMQ Game HTTP | `31983` | TCP | RabbitMQ management/API endpoint used by game stack | **Yes** |
| RabbitMQ local management | `15672` | TCP | Fixed `127.0.0.1:15672` | No |
| Text Router | `5059` | TCP | Host loopback -> container `5059` | No |
| Director | `11717` | TCP | Host loopback -> container `11717` | No |
| Web Console | `8088` | TCP | Operator Web UI; host networking | Optional; only if intentionally exposed |
| Prometheus | `9090` | TCP | Loopback by default in metrics Compose | No by default |

### Why `31982` and `31983` both matter

`runtime/scripts/start-rabbitmq.sh` publishes the game RabbitMQ container as:

```bash
-p "${RMQ_GAME_PORT}:5672/tcp"
-p 127.0.0.1:15672:15672/tcp
-p "${RMQ_GAME_HTTP_PORT}:15672/tcp"
```

More importantly, `runtime/scripts/start-server-gateway.sh` launches the gateway with the advertised public server address and both configured RMQ ports:

```bash
--RMQGameHostname="$SERVER_IP"
--RMQGamePort="${RMQ_GAME_PORT}"
--RMQGameHttpPort="${RMQ_GAME_HTTP_PORT}"
```

Therefore two battlegroups sharing one `SERVER_IP` cannot both use the same public `RMQ_GAME_PORT`/`RMQ_GAME_HTTP_PORT` pair.

### Why the player range must differ

The game processes use host networking and publish their external game address using the configured public `SERVER_IP`. The runtime separately keeps `-MultiHome` on the local bind address. `runtime/scripts/network-addresses.sh` normalizes `game_addr` to the advertised address while retaining the IGW address on the local/bind side.

For a NAT deployment, that produces the intended model:

```text
Player traffic:  public SERVER_IP + unique game UDP port
IGW traffic:     VM/LAN bind IP + IGW UDP port
```

This distinction is why IGW should not be blindly forwarded to the Internet.

---

## 4. Recommended multi-server port plan

The following allocation gives three battlegroups predictable, non-overlapping public player ranges and separate service profiles.

| Setting | VM1 / Server 1 | VM2 / Server 2 | VM3 / Server 3 |
|---|---:|---:|---:|
| `Port` / player base | `7777` | `7877` | `7977` |
| Player UDP pool | `7777-7810` | `7877-7910` | `7977-8010` |
| `IGWPort` base | `7888` | `7988` | `8088` |
| IGW UDP pool | `7888-7921` | `7988-8021` | `8088-8121` |
| `POSTGRES_PORT` | `15432` | `16432` | `17432` |
| `RMQ_ADMIN_PORT` | `32573` | `33573` | `34573` |
| `RMQ_GAME_PORT` | `31982` | `32982` | `33982` |
| `RMQ_GAME_HTTP_PORT` | `31983` | `32983` | `33983` |
| `TEXT_ROUTER_PORT` | `5059` | `5159` | `5259` |
| `DIRECTOR_PORT` | `11717` | `12717` | `13717` |
| Web Console | `8088` | `8090` | `8092` |

The numeric overlap between one VM's private IGW UDP pool and another VM's public player range is not a collision because the VMs have different LAN IPs and IGW is not mapped to the shared WAN endpoint. Inside a single VM, TCP and UDP are also distinct namespaces; for example a TCP Web Console on `8092` does not collide with an IGW UDP socket on `8092`.

Do not extend this table indefinitely without checking the resulting ranges. For four or more battlegroups, maintain an explicit IP/port allocation registry and verify that:

1. player UDP ranges do not overlap each other on the shared public IP;
2. public TCP service ports do not overlap each other on the shared public IP;
3. `Port` and `IGWPort` ranges do not intersect within the same VM;
4. no selected port collides with another host service in that VM;
5. all values remain in the valid TCP/UDP port range `1-65535`.

---

## 5. VM and network prerequisites

Each Dune VM should have:

- a unique, static LAN IPv4 address or DHCP reservation;
- its own Docker Engine and Docker Compose installation;
- its own repository checkout;
- its own runtime state and Docker volumes;
- a unique Dune battlegroup identity appropriate to the Funcom token/authorization being used;
- DNS/NTP/time synchronization;
- sufficient CPU, RAM, and storage for the maps enabled on that battlegroup;
- unrestricted outbound Internet access required by the Dune/Funcom services;
- firewall rules matching that VM's assigned profile.

Example:

```text
Gateway/router:  192.168.68.1
Public IPv4:     203.0.113.25        # example only

DUNE-VM-01:      192.168.68.127
DUNE-VM-02:      192.168.68.128
DUNE-VM-03:      192.168.68.129
```

For Proxmox, bridge each VM onto the LAN through the appropriate `vmbr` bridge unless your environment intentionally uses routed/NATed VM networks. The Dune VM should see its own private address as a normal local interface.

### Do not use the public IP as the VM bind IP behind NAT

For normal home/office NAT:

```env
SERVER_IP_MODE=public
SERVER_IP=<your-public-IPv4>
SERVER_BIND_IP=<this-VM-LAN-IPv4>
```

`SERVER_IP` is the address advertised to external clients. `SERVER_BIND_IP` is the address on which local game sockets bind.

The runtime explicitly guards against problematic NAT behavior when `net.ipv4.ip_nonlocal_bind=1`. For ordinary NAT/port-forward hosting, keep:

```bash
sudo sysctl -w net.ipv4.ip_nonlocal_bind=0
```

Then make the setting persistent according to your Linux distribution if it was previously enabled.

---

## 6. Configure Server 1

Server 1 can use the stock service and UserEngine port values.

Example `.env` network identity:

```env
SERVER_IP_MODE=public
SERVER_IP=203.0.113.25
SERVER_BIND_IP=192.168.68.127
SERVER_TITLE="Dune Server 1"
```

The default UserEngine values are:

```ini
[URL]
Port=7777
IGWPort=7888
```

The default service profile is:

```env
POSTGRES_PORT=15432
RMQ_ADMIN_PORT=32573
RMQ_GAME_PORT=31982
RMQ_GAME_HTTP_PORT=31983
TEXT_ROUTER_PORT=5059
DIRECTOR_PORT=11717
ADMIN_BIND_PORT=8088
```

Explicitly writing the defaults is optional for the first VM, but doing so can make multi-server inventory easier to audit.

---

## 7. Configure Server 2

### 7.1 Configure the service ports in `.env`

On VM2, append the second-server service profile:

```bash
cat >> .env <<'EOF'

# Multi-server profile: Server 2
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=8090
ADMIN_WEB_PORT=8090

# Compatibility/documentation mirror only on current main.
# The authoritative player/IGW values are UserEngine settings; see below.
CLIENT_PORT_BASE=7877
IGW_PORT_BASE=7988
EOF
```

Why both `ADMIN_BIND_PORT` and `ADMIN_WEB_PORT`? `ADMIN_BIND_PORT` is the canonical setting exposed in `.env.example` and used by the installer/console. `docker-compose.web.yml` also accepts `ADMIN_WEB_PORT` as an override. Setting both to the same value removes ambiguity across current/older deployment paths.

### 7.2 Set the actual player and IGW bases through UserEngine

**Do not rely on `CLIENT_PORT_BASE=7877` and `IGW_PORT_BASE=7988` in `.env` to control current game allocation.**

On current upstream `main`, `resolve_client_port_base()` and `resolve_igw_port_base()` call `usersettings_engine_value port 7777` and `usersettings_engine_value igw_port 7888`. The authoritative persisted values live in `runtime/generated/usersettings.json` and are materialized into UserEngine configuration.

Preferred method: use the manager and edit the global UserEngine values:

```text
Dune manager
  -> Edit UserEngine (Global Defaults)
       -> Port
       -> IGWPort
```

Set:

```text
Port    = 7877
IGWPort = 7988
```

The manager explicitly exposes `Port` and `IGWPort` and warns that running map containers retain their old values until restarted.

For scripted/automated configuration, use the repository helper rather than hand-editing generated JSON:

```bash
python3 runtime/scripts/usersettings.py engine-set port 7877
python3 runtime/scripts/usersettings.py engine-set igw_port 7988
python3 runtime/scripts/usersettings.py materialize-current
```

Then restart/recreate the Dune map processes so they receive the new values.

### 7.3 Configure VM2's address identity

VM2 advertises the **same public IPv4** as VM1 but binds to its own private address:

```env
SERVER_IP_MODE=public
SERVER_IP=203.0.113.25
SERVER_BIND_IP=192.168.68.128
SERVER_TITLE="Dune Server 2"
```

The unique ports, battlegroup identity, and VM LAN address distinguish the second deployment.

---

## 8. Configure Server 3

A third VM follows the same procedure.

`.env` example:

```bash
cat >> .env <<'EOF'

# Multi-server profile: Server 3
POSTGRES_PORT=17432
RMQ_ADMIN_PORT=34573
RMQ_GAME_PORT=33982
RMQ_GAME_HTTP_PORT=33983
TEXT_ROUTER_PORT=5259
DIRECTOR_PORT=13717
ADMIN_BIND_PORT=8092
ADMIN_WEB_PORT=8092

# Compatibility/documentation mirror only on current main.
CLIENT_PORT_BASE=7977
IGW_PORT_BASE=8088
EOF
```

Authoritative UserEngine settings:

```bash
python3 runtime/scripts/usersettings.py engine-set port 7977
python3 runtime/scripts/usersettings.py engine-set igw_port 8088
python3 runtime/scripts/usersettings.py materialize-current
```

Address identity:

```env
SERVER_IP_MODE=public
SERVER_IP=203.0.113.25
SERVER_BIND_IP=192.168.68.129
SERVER_TITLE="Dune Server 3"
```

---

## 9. Public firewall and NAT configuration

Only forward ports that actually need Internet-initiated access.

For the core game path, current upstream first-time initialization explicitly reminds public operators to forward:

```text
TCP 31982
TCP 31983
UDP 7777-7810
```

For multiple servers, apply the equivalent unique profile for each VM.

### Two-server NAT example

```text
# Server 1
PUBLIC_IP TCP 31982      -> 192.168.68.127 TCP 31982
PUBLIC_IP TCP 31983      -> 192.168.68.127 TCP 31983
PUBLIC_IP UDP 7777-7810  -> 192.168.68.127 UDP 7777-7810

# Server 2
PUBLIC_IP TCP 32982      -> 192.168.68.128 TCP 32982
PUBLIC_IP TCP 32983      -> 192.168.68.128 TCP 32983
PUBLIC_IP UDP 7877-7910  -> 192.168.68.128 UDP 7877-7910
```

If the Web Consoles must be reachable from the Internet:

```text
PUBLIC_IP TCP 8088 -> 192.168.68.127 TCP 8088
PUBLIC_IP TCP 8090 -> 192.168.68.128 TCP 8090
```

For Server 3:

```text
PUBLIC_IP TCP 33982      -> 192.168.68.129 TCP 33982
PUBLIC_IP TCP 33983      -> 192.168.68.129 TCP 33983
PUBLIC_IP UDP 7977-8010  -> 192.168.68.129 UDP 7977-8010
PUBLIC_IP TCP 8092       -> 192.168.68.129 TCP 8092   # only if Web UI is intentionally public
```

### Preserve ports 1:1 where possible

Prefer:

```text
PUBLIC_IP:32982 -> VM2:32982
PUBLIC_IP:32983 -> VM2:32983
```

rather than translating an arbitrary external port back to a different internal port. Keeping the same numeric port simplifies advertised-address behavior, logs, support, firewall audits, and troubleshooting.

### Do not forward these by default

Do **not** publish the following directly to the Internet unless you have a specific, reviewed architecture requiring it:

```text
PostgreSQL
RabbitMQ Admin
RabbitMQ local management 15672
Text Router
Director
IGW UDP pool
Prometheus
Docker daemon/socket
```

The stock runtime deliberately binds PostgreSQL, RabbitMQ Admin, Text Router, Director, and local RabbitMQ management to loopback where applicable.

---

## 10. NAT reflection / hairpin NAT is important

This is easy to overlook.

The Server Gateway is configured with:

```text
RMQ hostname = SERVER_IP
RMQ game port = RMQ_GAME_PORT
RMQ HTTP port = RMQ_GAME_HTTP_PORT
```

In a home/office NAT design, `SERVER_IP` is normally the router's public IPv4 while the Dune VM lives on a private LAN address. The gateway therefore needs to be able to reach the public address from inside the LAN and have that connection reflected back to the correct Dune VM.

Your router/firewall should support **NAT reflection**, **NAT loopback**, or **hairpin NAT** for the relevant public mappings.

For two VMs, the hairpin translations must remain unambiguous:

```text
LAN client -> PUBLIC_IP:31982 -> VM1:31982
LAN client -> PUBLIC_IP:32982 -> VM2:32982

LAN client -> PUBLIC_IP:31983 -> VM1:31983
LAN client -> PUBLIC_IP:32983 -> VM2:32983
```

If the router cannot hairpin these connections, the gateway may fail even though an external port-checking service shows the ports open. Resolve the routing/NAT design rather than pointing both battlegroups at the same RMQ endpoint.

---

## 11. Web Console exposure

The Web Console is not a normal static website. `docker-compose.web.yml` uses `network_mode: host`, and the console has access to the Docker socket. The Compose file explicitly warns that mounting `/var/run/docker.sock` grants broad control over the host Docker daemon.

Therefore the preferred order for remote administration is:

1. VPN/private management network;
2. authenticated TLS reverse proxy with strict access controls;
3. direct WAN port forwarding only when intentionally accepted and secured.

If using a reverse proxy, all consoles may share public TCP `443` using different DNS names/SNI while proxying to each VM internally:

```text
dune1.example.net:443 -> 192.168.68.127:8088
dune2.example.net:443 -> 192.168.68.128:8090
dune3.example.net:443 -> 192.168.68.129:8092
```

This avoids exposing multiple high-numbered admin ports directly while still retaining a unique internal profile.

Never disable console authentication on an Internet-facing deployment.

---

## 12. What each changed service port actually does

### `POSTGRES_PORT`

Default: `15432/TCP`.

`start-postgres.sh` publishes PostgreSQL as:

```bash
-p "127.0.0.1:${POSTGRES_PORT}:5432"
```

Host-network game processes use that configured host-side port in `-DatabaseHost=127.0.0.1:${POSTGRES_PORT}`. The Web Console can also derive its database port from `POSTGRES_PORT`.

### `RMQ_ADMIN_PORT`

Default: `32573/TCP`.

The admin RabbitMQ broker is published on loopback and is consumed by host-network game processes via the runtime-resolved RMQ admin host and port.

### `RMQ_GAME_PORT`

Default: `31982/TCP`.

This is the externally bound RabbitMQ TLS endpoint. It is part of the public battlegroup endpoint set and must be unique when several battlegroups share one public IPv4.

### `RMQ_GAME_HTTP_PORT`

Default: `31983/TCP`.

This maps the game RabbitMQ management/API listener. The Server Gateway is explicitly passed this port together with the public `SERVER_IP`; it is therefore part of the public endpoint identity and must be unique across battlegroups sharing one public IPv4.

### `TEXT_ROUTER_PORT`

Default: `5059/TCP`.

The Text Router container is published to loopback by the stock start script. It participates in the internal control plane and RabbitMQ authentication path. This guide offsets it per battlegroup to keep the entire service profile unique and diagnosable.

### `DIRECTOR_PORT`

Default: `11717/TCP`.

The Director is loopback-published by the stock runtime. Host-network game processes use `-battlegroup-director-url=127.0.0.1:${DIRECTOR_PORT}`. The per-server offset keeps each VM's complete profile internally consistent.

### `ADMIN_BIND_PORT` / `ADMIN_WEB_PORT`

Default Web Console port: `8088/TCP`.

`.env.example` defines `ADMIN_BIND_PORT=8088`. The Web Compose path accepts:

```yaml
ADMIN_BIND_PORT: "${ADMIN_WEB_PORT:-${ADMIN_BIND_PORT:-8088}}"
```

Use `ADMIN_BIND_PORT` as the canonical current setting. `ADMIN_WEB_PORT` may be mirrored for compatibility with the Compose override path.

### UserEngine `Port`

Default: `7777/UDP`.

This is the starting player-facing game port. The runtime allocates additional map processes from subsequent values, currently through `Port + 33`.

### UserEngine `IGWPort`

Default: `7888/UDP`.

This is the starting server-to-server IGW port. The runtime allocates the corresponding sequence separately from the player range. The two ranges must not intersect within one battlegroup.

---

## 13. Why `.env` is not enough for `Port` and `IGWPort`

`docker-compose.web.yml` passes `CLIENT_PORT_BASE` and `IGW_PORT_BASE` into the Web Console environment, and older deployment notes may show these variables in `.env`. However, on the validated current upstream runtime, the game allocator resolves its bases through:

```bash
resolve_client_port_base() {
  usersettings_engine_value port 7777
}

resolve_igw_port_base() {
  usersettings_engine_value igw_port 7888
}
```

`usersettings.py` defines the corresponding engine fields:

```python
"port": ("URL", "Port", "7777")
"igw_port": ("URL", "IGWPort", "7888")
```

Therefore the safe procedure is:

1. put service-port overrides in `.env`;
2. set player/IGW base values using `manager.sh` or `usersettings.py`;
3. materialize the current config;
4. restart map containers.

Treat `.env` copies of `CLIENT_PORT_BASE`/`IGW_PORT_BASE` as documentation/compatibility metadata unless the runtime source in your installed version explicitly changes that behavior.

---

## 14. Deployment sequence for each additional VM

Use this sequence for VM2, VM3, and later battlegroups.

### Step 1 — Create the VM

Assign:

- unique VM name;
- unique static/reserved LAN IP;
- adequate CPU/RAM/storage;
- normal outbound Internet connectivity.

### Step 2 — Install the Dune Docker stack

Install/clone the repository normally. Do not copy another VM's live Docker volume state unless you explicitly intend to clone that world and understand the identity implications.

### Step 3 — Establish a unique battlegroup identity

Run the normal first-time initialization flow and ensure the generated battlegroup/self-host identity is valid for the Funcom token in use. Do not reuse a generated battlegroup ID merely because the machines share a public IP.

### Step 4 — Configure `SERVER_IP` and `SERVER_BIND_IP`

Example VM2:

```env
SERVER_IP_MODE=public
SERVER_IP=203.0.113.25
SERVER_BIND_IP=192.168.68.128
```

### Step 5 — Apply that VM's service-port profile

For VM2:

```env
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=8090
ADMIN_WEB_PORT=8090
```

### Step 6 — Apply UserEngine `Port` and `IGWPort`

VM2:

```text
Port=7877
IGWPort=7988
```

### Step 7 — Configure router/NAT/firewall rules

Create public mappings for the VM's unique:

- `RMQ_GAME_PORT/TCP`;
- `RMQ_GAME_HTTP_PORT/TCP`;
- player UDP range;
- Web Console only if remote direct access is intentionally required.

### Step 8 — Start/restart the full stack

Use the normal repository commands for your version. Restart existing map containers after changing UserEngine port values.

### Step 9 — Validate locally

Run:

```bash
dune doctor
dune status
dune ready
```

Also inspect listeners:

```bash
sudo ss -lntup
```

Check the expected values for that VM rather than assuming the default first-server ports.

### Step 10 — Validate public reachability

From a machine genuinely outside the LAN, verify the TCP public endpoints. For example:

```bash
nc -vz <PUBLIC_IP> 32982
nc -vz <PUBLIC_IP> 32983
```

For RabbitMQ TLS, a TLS handshake is a stronger transport test:

```bash
openssl s_client -connect <PUBLIC_IP>:32982 -brief </dev/null
```

A self-signed certificate verification warning is different from a routing failure; the important network test is whether a TLS endpoint answers.

UDP cannot be validated reliably by a simple TCP-style port-open probe. Validate the game UDP path through actual game discovery/join/map-travel behavior and packet capture where necessary.

### Step 11 — Validate hairpin access from inside

From VM2, verify that the public endpoint resolves back to VM2 through the router:

```bash
nc -vz <PUBLIC_IP> 32982
nc -vz <PUBLIC_IP> 32983
```

If external tests pass but these internal-to-public tests fail, investigate NAT reflection/hairpin behavior.

---

## 15. Verification checklist

Before calling an additional battlegroup production-ready, verify all of the following.

### Identity and addressing

- [ ] VM has a unique LAN IP.
- [ ] `SERVER_IP_MODE=public`.
- [ ] `SERVER_IP` is the shared public IPv4.
- [ ] `SERVER_BIND_IP` is that VM's actual LAN address.
- [ ] Battlegroup identity is unique and valid for the deployment.
- [ ] `net.ipv4.ip_nonlocal_bind=0` for ordinary NAT hosting.

### Port profile

- [ ] `POSTGRES_PORT` matches the assigned profile.
- [ ] `RMQ_ADMIN_PORT` matches the assigned profile.
- [ ] `RMQ_GAME_PORT` matches the assigned profile.
- [ ] `RMQ_GAME_HTTP_PORT` matches the assigned profile.
- [ ] `TEXT_ROUTER_PORT` matches the assigned profile.
- [ ] `DIRECTOR_PORT` matches the assigned profile.
- [ ] Web Console port matches the assigned profile.
- [ ] UserEngine `Port` matches the assigned player base.
- [ ] UserEngine `IGWPort` matches the assigned IGW base.
- [ ] player and IGW ranges do not overlap inside that VM.

### NAT/firewall

- [ ] unique RMQ Game TCP mapping exists.
- [ ] unique RMQ Game HTTP TCP mapping exists.
- [ ] complete player UDP range is mapped to the correct VM.
- [ ] IGW is not unnecessarily WAN-forwarded.
- [ ] database/internal control-plane ports are not unnecessarily WAN-forwarded.
- [ ] Web UI is either private/VPN/reverse-proxied or intentionally mapped and secured.
- [ ] router supports the required NAT reflection/hairpin behavior.

### Runtime

- [ ] `dune doctor` passes or only reports understood warnings.
- [ ] expected TCP/UDP listeners appear in `ss -lntup`.
- [ ] `dune ready` reaches the expected ready state.
- [ ] gateway logs show normal startup rather than RMQ connection loops.
- [ ] Director/Funcom heartbeat behavior is healthy.
- [ ] server appears correctly in discovery/directory behavior expected for the deployment.
- [ ] player can join.
- [ ] player can travel between maps without being sent to the wrong battlegroup or private IP.

---

## 16. Troubleshooting

### Second server appears, but players cannot join

Check:

1. UserEngine `Port`, not just `CLIENT_PORT_BASE` in `.env`;
2. complete VM2 UDP range is forwarded to VM2;
3. `SERVER_BIND_IP` is VM2's LAN address;
4. `SERVER_IP` is the public address;
5. public address override is active in public mode;
6. firewall permits UDP on the entire assigned range.

Inspect:

```bash
python3 runtime/scripts/usersettings.py engine-values
sudo ss -lnup

dune doctor
```

### VM2 starts on `7777` even though `.env` says `CLIENT_PORT_BASE=7877`

This is expected on the validated current runtime if UserEngine was not changed. Set:

```bash
python3 runtime/scripts/usersettings.py engine-set port 7877
python3 runtime/scripts/usersettings.py engine-set igw_port 7988
python3 runtime/scripts/usersettings.py materialize-current
```

Then restart the map processes.

### VM2 gateway cannot reach RabbitMQ

Check:

```bash
nc -vz <PUBLIC_IP> 32982
nc -vz <PUBLIC_IP> 32983
```

from **inside VM2**.

If external access works but internal access fails, the likely issue is NAT reflection/hairpin routing. Remember that the gateway is explicitly launched against `SERVER_IP` plus the configured RMQ Game and RMQ Game HTTP ports.

### One battlegroup connects to another battlegroup's RMQ

This normally indicates a duplicate/misdirected NAT mapping or duplicate public RMQ port assignment. Audit the router against the port registry and verify each VM's `.env`.

### Map travel returns a private IP or wrong server

Run:

```bash
dune doctor
runtime/scripts/network-addresses.sh status
```

Verify that the game address resolves to the public `SERVER_IP` and IGW resolves to the local/bind address. Check `SERVER_IP_MODE`, `SERVER_IP`, `SERVER_BIND_IP`, and `net.ipv4.ip_nonlocal_bind`.

### Web Console opens the wrong VM

Two port forwards cannot claim the same public `PUBLIC_IP:8088/TCP`. Give each console a unique public/internal profile, or use a reverse proxy with unique DNS hostnames.

### Service ports appear different from this guide after an upgrade

Do not force the old values blindly. Re-check the runtime resolver and start scripts listed in [Source-of-truth files](#source-of-truth-files). This guide is a living document and should be updated when source behavior changes.

---

## 17. Security guidance

A multi-server host increases blast radius if management services are unnecessarily exposed.

At minimum:

- never expose PostgreSQL directly to the Internet;
- never expose the Docker daemon/socket to the Internet;
- keep RabbitMQ Admin and local management private unless a reviewed design explicitly requires otherwise;
- keep Text Router and Director private;
- do not forward IGW merely because it is part of the game runtime;
- protect the Web Console with authentication and preferably VPN or TLS reverse proxy access;
- use host and edge firewall rules, not just Docker's published-port behavior;
- restrict hypervisor management to a dedicated management network/VPN;
- keep each VM patched independently;
- back up each battlegroup independently;
- do not reuse secrets or generated world identity files casually between battlegroups.

The Web Console's Docker-socket mount is specifically security-sensitive: compromise of the console can imply control over the VM's Docker daemon. Treat it as an administrative control plane, not a public website.

---

## 18. Capacity planning notes

VM isolation solves namespace and port collisions; it does not make the workload free.

The runtime's current default memory recommendations include approximately:

```text
Survival_1:   16 GiB
Overmap:       3 GiB
DeepDesert_1: 16 GiB
```

Additional dynamic maps, databases, RabbitMQ, Director, Text Router, gateway, Docker, Linux page cache, metrics, and administrative services require additional headroom. Do not size a VM by summing only the two always-visible map processes.

For several battlegroups on one hypervisor:

- preserve physical RAM headroom for Proxmox/Linux and filesystem cache;
- avoid aggressive memory overcommit on latency-sensitive game VMs;
- monitor swap activity and host memory pressure;
- consider CPU NUMA/socket topology on large dual-socket hosts;
- avoid pinning all VMs to the same physical cores;
- use SSD/NVMe-backed storage appropriate to PostgreSQL and game state;
- monitor NIC saturation, packet loss, retransmits, latency, and buffer pressure;
- stagger updates/restarts when practical so all battlegroups do not peak simultaneously.

Use the repository's diagnostics and metrics capabilities where available, but validate the hypervisor as well as the guest VMs.

---

## 19. Upgrade and change-management procedure

Before applying a repository upgrade to a multi-server host:

1. read release notes/change log;
2. check whether any port resolver or service startup script changed;
3. back up each battlegroup;
4. record current `.env` service-port values;
5. record UserEngine `Port` and `IGWPort` values;
6. update one non-critical/test battlegroup first when possible;
7. run `dune doctor`, `dune status`, and `dune ready`;
8. validate public join and map travel;
9. only then roll the update to remaining VMs.

Useful inventory commands:

```bash
grep -E '^(SERVER_IP|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT)=' .env

python3 runtime/scripts/usersettings.py engine-values | grep -E $'^(port|igw_port)\t'

sudo ss -lntup
```

Do not assume an old `.env` port profile is still honored after a significant runtime refactor; verify the resolver source.

---

## 20. Source-of-truth files

The following files are the primary references for this guide. Links below point to the repository paths so readers can inspect the version they are running.

| Area | Source |
|---|---|
| Environment/service port defaults | [`runtime/scripts/runtime-env.sh`](../../runtime/scripts/runtime-env.sh) |
| Default `Port` / `IGWPort` | [`runtime/defaults/UserEngine.ini`](../../runtime/defaults/UserEngine.ini) |
| UserEngine field schema/persistence | [`runtime/scripts/usersettings.py`](../../runtime/scripts/usersettings.py) |
| Interactive UserEngine editor | [`runtime/scripts/manager.sh`](../../runtime/scripts/manager.sh) |
| Dynamic game/IGW port allocator | [`runtime/scripts/spawn-server.sh`](../../runtime/scripts/spawn-server.sh) |
| Overmap port assignment | [`runtime/scripts/start-server-overmap.sh`](../../runtime/scripts/start-server-overmap.sh) |
| Survival port assignment | [`runtime/scripts/start-server-survival-1.sh`](../../runtime/scripts/start-server-survival-1.sh) |
| PostgreSQL host binding | [`runtime/scripts/start-postgres.sh`](../../runtime/scripts/start-postgres.sh) |
| RabbitMQ bindings | [`runtime/scripts/start-rabbitmq.sh`](../../runtime/scripts/start-rabbitmq.sh) |
| Text Router binding | [`runtime/scripts/start-text-router.sh`](../../runtime/scripts/start-text-router.sh) |
| Director binding | [`runtime/scripts/start-director.sh`](../../runtime/scripts/start-director.sh) |
| Server Gateway public RMQ configuration | [`runtime/scripts/start-server-gateway.sh`](../../runtime/scripts/start-server-gateway.sh) |
| Advertised vs IGW address reconciliation | [`runtime/scripts/network-addresses.sh`](../../runtime/scripts/network-addresses.sh) |
| First-time public-port reminder | [`runtime/scripts/init.sh`](../../runtime/scripts/init.sh) |
| Runtime port/readiness diagnostics | [`runtime/scripts/doctor.sh`](../../runtime/scripts/doctor.sh) |
| Web Console host-network configuration | [`docker-compose.web.yml`](../../docker-compose.web.yml) |
| Web Console port/default configuration | [`console/api/src/config.js`](../../console/api/src/config.js) |
| User-facing environment defaults | [`.env.example`](../../.env.example) |
| Optional metrics host bindings | [`docker-compose.metrics.yml`](../../docker-compose.metrics.yml) |

For historical reproducibility, this revision was researched against upstream commit:

```text
7b7d8f1950a278e6431519841d5408cf04c582fb
```

When investigating a discrepancy, trust the runtime source and the effective listeners on the running VM over an old screenshot, forum post, or copied configuration fragment.

---

## 21. Quick-reference: Server 2

For operators who have already read the architectural and safety sections, this is the condensed second-server profile.

### `.env`

```env
SERVER_IP_MODE=public
SERVER_IP=<SAME_PUBLIC_IP_AS_SERVER_1>
SERVER_BIND_IP=<SERVER_2_LAN_IP>

POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=8090
ADMIN_WEB_PORT=8090

# Optional compatibility/documentation mirror; do not rely on these alone.
CLIENT_PORT_BASE=7877
IGW_PORT_BASE=7988
```

### Authoritative UserEngine port settings

```bash
python3 runtime/scripts/usersettings.py engine-set port 7877
python3 runtime/scripts/usersettings.py engine-set igw_port 7988
python3 runtime/scripts/usersettings.py materialize-current
```

### Public NAT

```text
TCP 32982      -> SERVER_2_LAN_IP:32982
TCP 32983      -> SERVER_2_LAN_IP:32983
UDP 7877-7910  -> SERVER_2_LAN_IP:7877-7910
TCP 8090       -> SERVER_2_LAN_IP:8090   # only if direct Web Console WAN access is intended
```

### Keep private

```text
TCP 16432      PostgreSQL
TCP 33573      RabbitMQ Admin
TCP 5159       Text Router
TCP 12717      Director
UDP 7988-8021  IGW server-to-server
TCP 15672      RabbitMQ local management
```

Then restart the appropriate runtime/map processes and validate with:

```bash
dune doctor
dune status
dune ready
sudo ss -lntup
```

---

## 22. Summary

Multiple Dune: Awakening self-hosted battlegroups can share one physical machine and one public IPv4 address when they are isolated into separate VMs and given distinct endpoint profiles.

The essential model is:

```text
one physical host
+ one public IPv4
+ one isolated VM per battlegroup
+ one unique LAN IP per VM
+ one unique public RMQ Game port per battlegroup
+ one unique public RMQ Game HTTP port per battlegroup
+ one unique public player UDP range per battlegroup
+ one unique operator Web endpoint when exposed
+ correct UserEngine Port/IGWPort configuration
+ correct public SERVER_IP and local SERVER_BIND_IP
+ working firewall/NAT reflection
= multiple independent public Dune battlegroups
```

Do not reduce the design to “change RabbitMQ and it should work.” The Dune stack is a multi-service control plane with generated game-server endpoints. Treat the complete port/address profile as configuration that belongs to the battlegroup, document it, validate it after upgrades, and keep internal control-plane services private.