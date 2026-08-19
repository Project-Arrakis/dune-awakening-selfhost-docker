# Quick Start Guide

**Status:** Current | **Last Updated:** August 2026

Get your Dune: Awakening self-hosted server up and running in minutes.

## Prerequisites

Before you begin, ensure you have:

- **A Linux server** (Ubuntu 20.04+ recommended, or Docker Desktop on Windows/WSL2)
- **Docker & Docker Compose** installed (the installer can set this up for you)
- **At least 20 GB RAM** (more for additional maps)
- **200+ GB storage space**
- **A Funcom token** (obtained from your Funcom account)
- **Basic command-line familiarity** (no deep Linux knowledge required)

See the main [README](../README.md) for full requirements.

## Installation Steps

### 1. Clone or Download the Repository

```bash
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
```

### 2. Run the Installer

```bash
chmod +x install.sh
./install.sh
```

The installer will:
- Check your system compatibility
- Set up Docker if needed
- Guide you through initial configuration
- Create the `.env` file with your settings

### 3. Complete Browser Setup

Once the installer finishes:

1. Open your browser to the address shown in the terminal
2. Enter your **Funcom token** when prompted
3. Configure your server:
   - Server name and description
   - Player slots
   - Map selection
   - Game difficulty settings
4. Create an admin account

### 4. Start the Server

```bash
dune up
```

Check server status:
```bash
dune status
```

View logs:
```bash
dune logs
```

## First Steps as an Admin

Once your server is running:

1. **Access the Console** — Visit the web console (shown after `dune up`)
2. **Check Server Health** — The dashboard shows online players, server status, and resource usage
3. **Configure Players** — Go to the Players section to manage admins and permissions
4. **Set Up Backups** — Enable automatic database backups (Settings > Backups)
5. **Invite Players** — Share your server IP with friends to join

## Common Commands

```bash
# Start the server
dune up

# Stop the server gracefully
dune down

# Check server status and player count
dune status

# View recent logs
dune logs

# Run a backup
dune db backup

# Restore from a backup
dune db restore <backup-file>

# Update to the latest version
dune update

# Run diagnostics
dune doctor
```

## Next Steps

- **[Web Console Guide](console/web-console-overview.md)** — Learn the console features
- **[Player Management](console/player-management.md)** — Manage your community
- **[Security Setup](security/security-overview.md)** — Harden your deployment
- **[Addon System](addons/addon-overview.md)** — Extend with community addons

## Troubleshooting

**Server won't start?**
- Run `dune doctor` for diagnostics
- Check `dune logs` for errors
- Ensure Docker is running: `docker ps`

**Out of memory?**
- Check available RAM: `free -h`
- Reduce the number of always-on maps
- See [Memory Guidance](../README.md#memory--cpu-guidance)

**Can't access the console?**
- Verify the console container is running: `docker ps | grep console`
- Check your network firewall allows port 8088
- Ensure your `.env` has the correct `SERVER_IP`

**Still stuck?**
- Check [Discord Integration FAQ](integrations/discord-integration/faq.md)
- Review [Troubleshooting Guide](integrations/discord-integration/troubleshooting.md)
- Open an issue on [GitHub](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues)

## Getting Help

- **[Official Website](https://dunedocker.app/)** — Resources and community
- **[GitHub Issues](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues)** — Report bugs
- **[Discussions](https://github.com/yacketrj/dune-awakening-selfhost-docker/discussions)** — Ask questions

---

**Next:** Once you're comfortable with the basics, explore the [Console Guide](console/web-console-overview.md) to learn about advanced features.
