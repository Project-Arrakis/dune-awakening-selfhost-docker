#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

# Read the literal startup configuration, not a second copy of the defaults.
# No Docker calls or live configuration writes are needed for this regression.
python3 - "$repo_root/runtime/scripts/start-director.sh" <<'PY'
import configparser
from pathlib import Path
import re
import sys

script = Path(sys.argv[1]).read_text()
match = re.search(r"cat > runtime/director/config/director_config.ini <<'EOF'\n(.*?)\nEOF", script, re.S)
assert match, "Director startup config block was not found"
config = configparser.ConfigParser()
config.read_string(match.group(1))
assert config.get("Battlegroup", "AuthorizationPreset") == "BattlegroupInternal"
interval = config.getint("Battlegroup", "FlsServerHeartbeatUpdateFrequencySeconds")
# A stable, unchanged Sietch must refresh several times within the observed
# five-minute browser expiry window. Population and battlegroup heartbeats
# are distinct messages and cannot substitute for this per-Sietch setting.
assert 30 <= interval <= 60, f"Unsafe Sietch browser heartbeat interval: {interval}"
assert script.count("FlsServerHeartbeatUpdateFrequencySeconds=") == 1
print("PASS: Director startup config refreshes unchanged Sietch heartbeats within 60 seconds")
PY
