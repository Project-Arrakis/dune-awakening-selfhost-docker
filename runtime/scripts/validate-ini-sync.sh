#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

USERSETTINGS="runtime/scripts/usersettings.py"
ROOT_DIR="runtime/generated/ini-sync-validation"
BASE_DIR="$ROOT_DIR/survival-1/Saved/UserSettings"
ENGINE="$BASE_DIR/UserEngine.ini"
GAME="$BASE_DIR/UserGame.ini"
CONFIG="$ROOT_DIR/usersettings.json"
PROFILE="$ROOT_DIR/gameplay-profile.ini"

rm -rf "$ROOT_DIR"
mkdir -p "$BASE_DIR"

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" materialize Survival_1 "$ROOT_DIR/survival-1/Saved" 1

cat >> "$GAME" <<'EOF'

[Custom.Section]
CustomKey=KeepMe
; custom comment
EOF

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" partition-set Survival_1 1 default_reconnect_grace_period_seconds 450 >/dev/null
game_values="$(DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" partition-values Survival_1 1)"
if ! grep -q $'default_reconnect_grace_period_seconds\t450' <<< "$game_values"; then
  echo "UserGame live value was not reflected." >&2
  exit 1
fi
DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" partition-set Survival_1 1 guild_settings_creation_cost 2000 >/dev/null
grep -q 'CustomKey=KeepMe' "$GAME" || { echo "UserGame unknown key was not preserved." >&2; exit 1; }
grep -q '; custom comment' "$GAME" || { echo "UserGame comment was not preserved." >&2; exit 1; }

cat >> "$ENGINE" <<'EOF'

[Custom.Engine]
EngineCustomKey=KeepMeToo
; engine custom comment
EOF

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" engine-set mining_output_multiplier 7.77 >/dev/null
engine_values="$(DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" engine-values)"
if ! grep -q $'mining_output_multiplier\t7.77' <<< "$engine_values"; then
  echo "UserEngine live value was not reflected." >&2
  exit 1
fi
DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" DUNE_GAMEPLAY_PROFILE="$PROFILE" python3 "$USERSETTINGS" engine-set vehicle_mining_output_multiplier 8.88 >/dev/null
grep -q 'EngineCustomKey=KeepMeToo' "$ENGINE" || { echo "UserEngine unknown key was not preserved." >&2; exit 1; }
grep -q '; engine custom comment' "$ENGINE" || { echo "UserEngine comment was not preserved." >&2; exit 1; }

echo "INI sync validation passed."
