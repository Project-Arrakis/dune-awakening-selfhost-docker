# Container Architecture

**Status:** Current | **Last Updated:** August 2026

Overview of the Docker container architecture and how components interact.

## Architecture Overview

The Dune: Awakening Docker deployment uses a microservices architecture with isolated containers:

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Network                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐    ┌──────────────┐  ┌─────────────┐ │
│  │  Game Server │    │ Console API  │  │  Web UI     │ │
│  │  (UserEngine)│    │  (Node.js)   │  │  (React)    │ │
│  └──────┬───────┘    └──────┬───────┘  └─────────────┘ │
│         │                   │                           │
│  ┌──────▼──────────────────▼───────────────────────┐   │
│  │       Database Layer (PostgreSQL + Redis)       │   │
│  └────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────┐       ┌──────────────────────┐   │
│  │ Addon System    │       │ Observability Stack  │   │
│  │ (JavaScript)    │       │ (Prometheus, Grafana)│   │
│  └─────────────────┘       └──────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
         │              │              │              │
      Port 7777      Port 8088      Port 3000      Port 9090
    (Game Server)  (Console)      (Metrics)       (Prometheus)
```

## Container Stack

### Core Containers

**dune-game** (UserEngine)
- The official Dune game server binary
- Runs the game simulation
- Listens on UDP port 7777 (player connections)
- Memory: 4-12 GB (depends on map count)

**dune-console-api** (Node.js)
- REST API backend
- Database abstraction layer
- Player management logic
- Listens on TCP port 3001 (internal)
- Memory: 512 MB - 1 GB

**dune-console-web** (Nginx)
- React.js frontend
- Admin dashboard UI
- Listens on TCP port 8088 (admin access)
- Memory: 256 MB
- Serves static assets

### Database Layer

**dune-postgres**
- PostgreSQL database
- Stores player data, bases, progression
- Listens on TCP port 5432 (internal only)
- Storage: 20-100 GB (depends on player count)
- Backup/restore procedures available

**dune-redis**
- Redis caching layer
- Session management
- Real-time player data caching
- Listens on TCP port 6379 (internal only)
- Memory: 1-4 GB

### Optional Addon Containers

**dune-observability-addon** (if enabled)
- Metrics collection and forwarding
- Discord notifications
- Runs custom JavaScript
- Memory: 256-512 MB

**dune-prometheus** (if metrics enabled)
- Time-series metrics database
- Performance monitoring
- Listens on TCP port 9090 (internal)
- Storage: 5-20 GB

**dune-grafana** (if metrics enabled)
- Metrics visualization dashboard
- Alerting rules
- Listens on TCP port 3000 (internal)
- Memory: 512 MB

## Communication Patterns

### Game Server → Console API

- **Protocol:** HTTPS (with auth token)
- **Purpose:** Player updates, command execution, status reporting
- **Frequency:** Continuous
- **Auth:** Command auth token (signed, time-limited)

### Console API → PostgreSQL

- **Protocol:** TCP (internal Docker network)
- **Purpose:** Data persistence
- **Auth:** Database credentials (from `.env`)
- **Persistence:** Critical data (players, bases, progression)

### Console API → Redis

- **Protocol:** TCP (internal Docker network)
- **Purpose:** Caching, sessions
- **Auth:** Redis password (from `.env`)
- **Data:** Transient (session state, temporary caches)

### Web UI → Console API

- **Protocol:** HTTPS (browser)
- **Purpose:** Admin dashboard operations
- **Auth:** Session tokens (from login)
- **Direction:** Bidirectional (REST + optional WebSocket)

### Addon System

Addons communicate via:

- **Internal JavaScript API** — Access to console functions
- **Database Queries** — Read/write to PostgreSQL (scoped)
- **Game Server API** — Limited command execution
- **External Services** — HTTP calls (Discord webhooks, etc.)

## Volume Mounts

Persistent data stored in Docker volumes:

```
dune_data       → PostgreSQL database files
dune_redis      → Redis snapshots
dune_game       → Game server data (maps, player saves)
dune_logs       → Service logs (optional)
dune_secrets    → Encrypted credentials
```

Or file system mounts for operational flexibility:

```
./runtime/data/         → Database files
./runtime/secrets/      → Credentials
./runtime/generated/    → Temporary/generated files
./runtime/logs/         → Application logs
```

## Network Configuration

### Internal Network (docker-compose network)

- **Type:** Bridge network
- **Access:** Only between containers
- **Security:** No external access possible
- **Communication:** By container name (DNS)

### External Ports

| Port | Container | Purpose | Protocol |
|------|-----------|---------|----------|
| 7777 | dune-game | Player connections | UDP |
| 8088 | dune-console-web | Admin console | TCP (HTTPS via proxy) |
| 3000 | dune-grafana | Metrics dashboard | TCP (internal) |
| 9090 | dune-prometheus | Metrics database | TCP (internal) |

### Reverse Proxy (Recommended)

For production, use a reverse proxy in front:

```
Internet → Nginx/Apache (TLS, auth) → Docker Host
                                       ↓
                              dune-console-web:8088
```

See [Container Hardening](../runtime/CONTAINER-HARDENING.md) for setup details.

## Resource Allocation

### Recommended Allocation

| Component | CPU | Memory | Storage |
|-----------|-----|--------|---------|
| Game Server | 4-8 cores | 8-16 GB | 50-100 GB |
| Console | 1-2 cores | 1-2 GB | 10 GB |
| Database | 2-4 cores | 4-8 GB | 20-100 GB |
| Addon System | 0.5-1 core | 512 MB-1 GB | 5 GB |
| Metrics | 1-2 cores | 2-4 GB | 10-20 GB |
| **Total** | **8-16** | **16-32 GB** | **100-250 GB** |

Scale up with player count and map complexity.

## Container Lifecycle

### Startup Sequence

1. Docker Compose reads `docker-compose.yml` and `.env`
2. Creates/starts containers in dependency order:
   - Volumes (data persistence)
   - PostgreSQL (database must be ready first)
   - Redis (cache)
   - Game Server (needs database connection)
   - Console API (needs database + game server)
   - Web UI (needs API)
   - Addons (after core stack is healthy)

3. Each container runs health checks
4. Waits for dependent services to be ready

### Shutdown Sequence

```bash
docker compose down
```

1. Sends SIGTERM to all containers (graceful shutdown)
2. Waits for services to finish in-flight requests
3. Database flushes pending writes
4. Game server saves final state
5. All containers stop
6. (Optional) Volumes removed with `--volumes`

### Restart Procedures

```bash
# Restart a single container
docker restart dune-game

# Restart all containers
docker compose restart

# Restart and rebuild
docker compose restart --build
```

## Monitoring & Diagnostics

### Health Checks

Each container has a health check:

```bash
docker ps --format "{{.Names}}\t{{.Status}}"
```

Example output:
```
dune-game           Up 2 hours (healthy)
dune-postgres       Up 2 hours (healthy)
dune-console-api    Up 2 hours (healthy)
dune-console-web    Up 2 hours (healthy)
```

### Container Logs

```bash
# All containers
docker compose logs -f

# Specific container
docker logs -f dune-game

# Recent 100 lines
docker logs --tail 100 dune-game
```

### Resource Usage

```bash
docker stats
```

Shows CPU, memory, network I/O per container.

### Debugging

```bash
# Interactive shell in a container
docker exec -it dune-console-api /bin/bash

# Copy files out
docker cp dune-game:/var/log/game.log ./

# Inspect container configuration
docker inspect dune-game
```

## Related Documentation

- [Container Hardening](../runtime/CONTAINER-HARDENING.md)
- [Metrics Stack](../runtime/metrics-stack.md)
- [Multi-Server Setup](../runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md)
- [Docker Compose Reference](../../docker-compose.yml)

---

**Need help?** See the [Troubleshooting Guide](../integrations/discord-integration/troubleshooting.md).
