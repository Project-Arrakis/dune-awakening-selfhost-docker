#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

python3 - <<'PY'
from pathlib import Path

source = Path("runtime/container/run-server.sh").read_text(encoding="utf-8")
mkdir = 'mkdir -p "/home/dune/.config/Epic/Unreal Engine/Engine"'
link = 'ln -sfn /home/dune/server/DuneSandbox/Saved/UserSettings "$config_path"'
ownership = 'chown -R dune:nogroup /home/dune/.config'
launch = 'su -s /bin/bash dune -c "$launch_script" &'

for statement in (mkdir, link, ownership, launch):
    assert statement in source
assert source.index(mkdir) < source.index(link) < source.index(ownership) < source.index(launch)
PY

echo "game launcher makes the Epic config directory writable before dropping privileges"
