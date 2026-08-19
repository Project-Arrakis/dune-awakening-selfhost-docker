# Installation & Setup Guide

**Status:** Current | **Last Updated:** August 2026

Complete, step-by-step guide for installing and configuring your Dune: Awakening self-hosted server.

## System Requirements

### Minimum Configuration

| Component | Requirement |
|-----------|------------|
| OS | Ubuntu 20.04+, Debian 11+, or Docker Desktop on Windows/WSL2 |
| CPU | x86-64 with AVX/AVX2 support |
| RAM | 20 GB minimum (30-40 GB recommended for multiple maps) |
| Storage | 200 GB+ free space |
| Network | Stable internet connection, static IP recommended |

### Recommended Setup for Growth

| Player Base | RAM | Storage | CPU |
|-------------|-----|---------|-----|
| 1-20 players, single map | 20 GB | 200 GB | 4 cores |
| 20-50 players, 2-3 maps | 30 GB | 300 GB | 6 cores |
| 50+ players, multiple maps | 40+ GB | 500+ GB | 8+ cores |

## Pre-Installation Checklist

Before running the installer, verify:

- [ ] You have root or sudo access to your server
- [ ] Docker is installed (or you'll install it now)
- [ ] At least 200 GB free disk space
- [ ] Your Funcom account is active
- [ ] You have obtained a Funcom token
- [ ] Your firewall allows the ports you plan to use (default: 7777 UDP for game, 8088 TCP for console)

## Step 1: Prepare Your System

### On Linux Servers

Update your system:
```bash
sudo apt update && sudo apt upgrade -y
```

Install basic dependencies:
```bash
sudo apt install -y git curl wget
```

### On Windows/WSL2

Ensure you have:
- [WSL2 installed](https://learn.microsoft.com/en-us/windows/wsl/install)
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) with WSL2 backend enabled
- A fresh Ubuntu 20.04+ WSL2 distribution

## Step 2: Clone the Repository

```bash
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
```

## Step 3: Run the Installer

Make the installer executable and run it:

```bash
chmod +x install.sh
./install.sh
```

The installer will:

1. **Check prerequisites** — Verify Docker, disk space, CPU features
2. **Optionally install Docker** — If Docker isn't found and you're on a supported distro
3. **Create directories** — Set up required folders for data and secrets
4. **Generate `.env` file** — Create your configuration file
5. **Build Docker images** — Compile images for your system (first run only)
6. **Start containers** — Bring up the stack

### What the Installer Creates

After running, you'll have:

```
dune-awakening-selfhost-docker/
├── .env                      # Your configuration (keep this secure!)
├── runtime/
│   ├── data/                 # Game databases (PostgreSQL, Redis)
│   ├── secrets/              # Tokens and credentials
│   ├── generated/            # Generated files
│   └── logs/                 # Service logs
├── docker-compose.yml        # Container orchestration
└── console/                  # Web console source
```

## Step 4: Browser Configuration

Once the installer completes, it will provide a URL for browser setup:

```
🎉 Installation complete! Visit your console at:
   http://YOUR.IP.ADDRESS:8088
```

1. **Open the URL** in your web browser
2. **Enter your Funcom token** when prompted
3. **Configure the game server:**
   - Server name and description
   - Player capacity (10-100 recommended to start)
   - Map selection (select 1-2 to begin)
   - Difficulty settings
   - PvP/PvE mode
4. **Create your admin account** with a strong password
5. **Review settings** and confirm

## Step 5: Verify Installation

Start the server:

```bash
dune up
```

Check that all containers are running:

```bash
docker ps
```

You should see containers for:
- `dune-game` — The game server
- `dune-console-api` — Console backend
- `dune-console-web` — Console web UI
- `dune-postgres` — Game database
- `dune-redis` — Cache layer

Check player-facing server is ready:

```bash
dune status
```

Example output:
```
🎮 Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status      : ✅ Running
Players     : 0 / 20
Map 1       : 🟢 Ready
Uptime      : 2 minutes
DB Status   : ✅ Healthy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Step 6: Open Access (Networking)

### For Local Network Only

No additional configuration needed. Players on your LAN can connect to `YOUR_LOCAL_IP:7777`.

### For Internet Access

You need to expose your server. Choose one approach:

#### Option A: Port Forwarding (Simple)

1. Log into your router's admin panel
2. Find **Port Forwarding** settings
3. Forward **UDP port 7777** to your server's local IP
4. Give players your **public IP** and port `7777`

**Pros:** Simple, free
**Cons:** Exposes your home IP, less secure

#### Option B: Cloud Server

Deploy on a cloud provider (AWS, Azure, Linode, etc.) for better:
- Uptime and reliability
- Network isolation
- DDoS protection

#### Option C: Wireguard VPN

Use Wireguard to tunnel game traffic securely:

```bash
# Install wireguard
sudo apt install wireguard wireguard-tools

# Generate keys (follow guides)
# Configure peers (players)
# Route game traffic through the VPN
```

## Step 7: Initial Configuration

### Set Admin Permissions

1. Log into the console at `http://YOUR.IP:8088`
2. Go to **Players** → **Manage Admin Roles**
3. Grant permissions to trusted players

### Enable Backups

1. Go to **Settings** → **Backups**
2. Enable **Automatic Daily Backups**
3. Set your preferred backup time
4. Test a backup and verify restoration

### Configure Maps

1. Go to **Maps** → **Map Settings**
2. Set always-on maps (loaded 24/7)
3. Configure difficulty per map
4. Enable story/social maps as desired

### Optional: Set Up Discord Integration

1. See [Discord Integration Setup](integrations/discord-integration/admin-guide.md)
2. Invite the bot to your Discord
3. Link your server to gain Discord monitoring

## Upgrading Later

To update to a newer version:

```bash
git pull origin main
dune update
```

This will:
- Fetch the latest upstream game version
- Rebuild Docker images
- Migrate your database if needed
- Restart the server with new code

See [CHANGELOG.md](../CHANGELOG.md) for what changed in each release.

## Common Setup Issues

### "Docker not found"

Install Docker:
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker
```

### "Not enough disk space"

The game requires ~150 GB for full setup. Check:
```bash
df -h /
```

Remove files or expand storage before continuing.

### "CPU doesn't support AVX"

This is a game engine requirement. Your CPU must have AVX/AVX2 support. Check:
```bash
grep avx /proc/cpuinfo
```

If empty, your CPU isn't compatible. Consider a different server.

### "Port 8088 already in use"

Another service is using the console port. Change it in `.env`:
```bash
CONSOLE_PORT=9088
```

Then restart:
```bash
dune down && dune up
```

### "Funcom token is invalid"

1. Verify your token is correct (copy/paste carefully)
2. Log into your Funcom account to confirm it's active
3. If tokens expire, get a fresh one from your account
4. Update `.env` and restart: `dune restart`

## Next Steps

Congratulations! Your server is ready. Now:

1. **[Quick Start Guide](quick-start.md)** — Run your first game session
2. **[Web Console Guide](console/web-console-overview.md)** — Learn console features
3. **[Player Management](console/player-management.md)** — Set up your community
4. **[Security Setup](security/security-overview.md)** — Harden your deployment

---

**Need help?** See the [Troubleshooting Guide](integrations/discord-integration/troubleshooting.md) or [open an issue on GitHub](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues).
