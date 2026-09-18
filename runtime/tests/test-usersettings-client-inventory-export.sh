#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$repo_root/runtime/scripts/usersettings.py" <<'PY'
import importlib.util
import sys

module_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("usersettings", module_path)
usersettings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usersettings)

profile = usersettings.parse_profile_text("")
default_export = usersettings.client_game_ini(profile, "Survival_1", "3")
assert "PlayerInventoryStartingSize=" not in default_export
assert "PlayerInventoryStartingVolumeCapacity=" not in default_export

section = "/Script/DuneSandbox.InventorySystemSettings"
usersettings.profile_set_key(profile, "global", section, "PlayerInventoryStartingSize", "50")
usersettings.profile_set_key(profile, "global", section, "PlayerInventoryStartingVolumeCapacity", "300")
client_export = usersettings.client_game_ini(profile, "Survival_1", "3")

assert f"[{section}]" in client_export
assert "PlayerInventoryStartingSize=50" in client_export
assert "PlayerInventoryStartingVolumeCapacity=300" in client_export
assert usersettings.CLIENT_FILE_REQUIRED["player_inventory_starting_size"] == "Game.ini"
assert usersettings.CLIENT_FILE_REQUIRED["player_inventory_starting_volume_capacity"] == "Game.ini"
PY

echo "Client inventory Game.ini export test passed."
