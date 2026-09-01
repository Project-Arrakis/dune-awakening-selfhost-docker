#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/runtime/scripts" "$TEST_ROOT/runtime/generated" "$TEST_ROOT/bin"
cp "$REPO_ROOT/runtime/scripts/deepdesert.sh" "$TEST_ROOT/runtime/scripts/deepdesert.sh"

cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "ps" ]; then
  printf '%s\n' dune-postgres dune-director dune-server-overmap
  exit 0
fi
if [ "${1:-}" != "exec" ]; then exit 2; fi
sql="${*: -1}"
case "$sql" in
  *"sum(coalesce(fs.connected_players"*) printf '%s\n' "${MOCK_CONNECTED_PLAYERS:-0}" ;;
  *"greatest(1, count(*))"*) printf '%s\n' "${MOCK_CURRENT_COUNT:-2}" ;;
  *"select partition_id"*"where map = 'DeepDesert_1'"*"order by dimension_index, partition_id"*) printf '%s\n' 8 33 69 ;;
  *"dimension_index = 0"*) printf '%s\n' 8 ;;
  *"dimension_index = 1"*) printf '%s\n' 33 ;;
  *"dimension_index = 2"*) printf '%s\n' 69 ;;
  *"coalesce(wp.server_id, '') <> ''"*"select partition_id"*) printf '%s\n' 8 33 ;;
  *"coalesce(wp.server_id, '') <> ''"*) printf '%s\n' '8|server-8|0' '33|server-33|0' ;;
  *"coalesce(fs.ready, false)"*"coalesce(fs.alive, false)"*) printf '%s\n' 't|t' ;;
  *) : ;;
esac
MOCK
chmod +x "$TEST_ROOT/bin/docker"

cat > "$TEST_ROOT/runtime/scripts/usersettings.py" <<'MOCK'
#!/usr/bin/env python3
import os
import sys

with open(os.environ["MOCK_CALLS"], "a", encoding="utf-8") as handle:
    handle.write(f"usersettings.py {' '.join(sys.argv[1:])}\n")

# Reproduce the real global-values shape with server_pve appearing before a
# substantial remainder. A reader that exits as soon as it sees server_pve
# closes the pipe early and makes Python exit 120, which previously aborted a
# first-time Single -> Dual transition before it created the second partition.
if sys.argv[1:] == ["global-values"]:
    print("server_pve\tTrue")
    for index in range(20000):
        print(f"setting_{index}\tvalue_{index}")
MOCK
chmod +x "$TEST_ROOT/runtime/scripts/usersettings.py"

for script in sietches.sh extract-partition-catalog.sh despawn-server.sh spawn-server.sh publish-deepdesert-state.sh start-server-overmap.sh; do
  cat > "$TEST_ROOT/runtime/scripts/$script" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "${MOCK_CALLS:?}"
MOCK
  chmod +x "$TEST_ROOT/runtime/scripts/$script"
done
cat > "$TEST_ROOT/runtime/scripts/publish-deepdesert-state.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "${MOCK_CALLS:?}"
[ "${MOCK_PUBLISH_FAIL:-0}" != "1" ]
MOCK
chmod +x "$TEST_ROOT/runtime/scripts/publish-deepdesert-state.sh"

cat > "$TEST_ROOT/runtime/scripts/map-modes.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'DeepDesert_1 dynamic'
MOCK
cat > "$TEST_ROOT/runtime/scripts/start-director.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' start-director >> "${MOCK_CALLS:?}"
MOCK
cat > "$TEST_ROOT/runtime/scripts/restart-director.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' restart-director >> "${MOCK_CALLS:?}"
MOCK
chmod +x "$TEST_ROOT/runtime/scripts/map-modes.sh" "$TEST_ROOT/runtime/scripts/start-director.sh" "$TEST_ROOT/runtime/scripts/restart-director.sh"

cat > "$TEST_ROOT/runtime/generated/director-deepdesert-dual.ini" <<'EOF'
; ManagedPvpPartition=8
; ManagedPvePartition=33
; ManagedPartitionIds=8,33
; ManagedInstanceCount=2
; ManagedThirdRole=pve
; ManagedPrimaryDisplayNameBase64=

[DeepDesert_1]
NumExtraServers=1
MinServers=0
EOF

calls="$TEST_ROOT/calls.log"
touch "$calls"
(
  cd "$TEST_ROOT"
  PATH="$TEST_ROOT/bin:$PATH" \
  MOCK_CALLS="$calls" \
  runtime/scripts/deepdesert.sh layout set 3 --third-role pvp --yes --force
) >/dev/null

if grep -Fxq restart-director "$calls"; then
  echo "FAIL: Triple Deep Desert used the Director recovery path and would restart Hagga Basin" >&2
  exit 1
fi
grep -Fxq start-director "$calls"
profile_line="$(grep -n 'usersettings.py map-set Global global_pvp_enabled_partition_add 69' "$calls" | cut -d: -f1)"
director_line="$(grep -n '^start-director$' "$calls" | cut -d: -f1)"
overmap_line="$(grep -n '^start-server-overmap.sh $' "$calls" | cut -d: -f1)"
activate_line="$(grep -n 'sietches.sh set-active DeepDesert_1 3 --defer-start' "$calls" | cut -d: -f1)"
if [ -z "$profile_line" ] || [ -z "$director_line" ] || [ -z "$overmap_line" ] || [ -z "$activate_line" ] \
  || [ "$profile_line" -ge "$director_line" ] || [ "$director_line" -ge "$overmap_line" ] \
  || [ "$overmap_line" -ge "$activate_line" ]; then
  echo "FAIL: the third PvP selector, Director, and Overland were not reloaded before activation" >&2
  cat "$calls" >&2
  exit 1
fi
if tail -n "+$activate_line" "$calls" | grep -Eq '(spawn|despawn)-server[.]sh (8|33)( |$)'; then
  echo "FAIL: Dual -> Triple touched an unchanged existing Deep Desert partition" >&2
  cat "$calls" >&2
  exit 1
fi
for expected in \
  'publish-deepdesert-state.sh once' \
  'spawn-server.sh 69' \
  'despawn-server.sh 69 --force'
do
  grep -Fxq "$expected" "$calls" || {
    echo "FAIL: missing sequential dynamic Kanly role-prime step: $expected" >&2
    cat "$calls" >&2
    exit 1
  }
done
for unexpected_partition in 8 33; do
  if grep -Fq "usersettings.py partition-set DeepDesert_1 $unexpected_partition " "$calls"; then
    echo "FAIL: Dual -> Triple rewrote unchanged partition $unexpected_partition settings" >&2
    cat "$calls" >&2
    exit 1
  fi
done
for expected in \
  'usersettings.py partition-set DeepDesert_1 69 partition_pvp_enabled True' \
  'usersettings.py partition-set DeepDesert_1 69 partition_pve_enabled False' \
  'usersettings.py partition-set DeepDesert_1 69 legacy_pvp_enabled True' \
  'usersettings.py partition-set DeepDesert_1 69 server_pve False' \
  'usersettings.py map-set Global server_pve False'
do
  if ! grep -Fxq "$expected" "$calls"; then
    echo "FAIL: missing per-partition role setting: $expected" >&2
    cat "$calls" >&2
    exit 1
  fi
done

# A direct Single -> Triple transition must initialize both newly-created
# dimensions, while preserving the existing primary partition.
: > "$calls"
cat > "$TEST_ROOT/runtime/generated/director-deepdesert-dual.ini" <<'EOF'
; ManagedPartitionIds=8
; ManagedInstanceCount=1
; ManagedThirdRole=pve
; ManagedPrimaryDisplayNameBase64=
; ManagedOriginalGlobalServerPVE=True

[DeepDesert_1]
NumExtraServers=0
MinServers=0
EOF
(
  cd "$TEST_ROOT"
  PATH="$TEST_ROOT/bin:$PATH" \
  MOCK_CALLS="$calls" \
  MOCK_CURRENT_COUNT=1 \
  runtime/scripts/deepdesert.sh layout set 3 --third-role pve --yes --force
) >/dev/null
for expected in \
  'spawn-server.sh 33' \
  'despawn-server.sh 33 --force' \
  'spawn-server.sh 69' \
  'despawn-server.sh 69 --force'
do
  grep -Fxq "$expected" "$calls" || {
    echo "FAIL: direct Single -> Triple missed new partition lifecycle step: $expected" >&2
    cat "$calls" >&2
    exit 1
  }
done
if grep -Eq '(spawn|despawn)-server[.]sh 8( |$)' "$calls"; then
  echo "FAIL: direct Single -> Triple touched the preserved primary partition" >&2
  cat "$calls" >&2
  exit 1
fi

: > "$calls"
if (
  cd "$TEST_ROOT"
  PATH="$TEST_ROOT/bin:$PATH" \
  MOCK_CALLS="$calls" \
  MOCK_CONNECTED_PLAYERS=2 \
  runtime/scripts/deepdesert.sh layout set 3 --third-role pvp --yes --force
) >"$TEST_ROOT/blocked.out" 2>&1; then
  echo "FAIL: layout change was allowed with connected Deep Desert players" >&2
  exit 1
fi
grep -Fq 'while 2 player(s) are connected to Deep Desert instances' "$TEST_ROOT/blocked.out"
[ ! -s "$calls" ]

: > "$calls"
cat > "$TEST_ROOT/runtime/generated/director-deepdesert-dual.ini" <<'EOF'
; ManagedPvpPartition=8
; ManagedPvePartition=33
; ManagedPartitionIds=8,33
; ManagedInstanceCount=2
; ManagedThirdRole=pve
; ManagedPrimaryDisplayNameBase64=

[DeepDesert_1]
NumExtraServers=1
MinServers=0
EOF
(
  cd "$TEST_ROOT"
  PATH="$TEST_ROOT/bin:$PATH" \
  MOCK_CALLS="$calls" \
  MOCK_PUBLISH_FAIL=1 \
  runtime/scripts/deepdesert.sh layout set 3 --third-role pvp --yes --force
) >/dev/null
grep -Fxq 'despawn-server.sh 69 --force' "$calls"

echo "PASS: Deep Desert layout changes only the new partition, leaves Hagga online, and blocks connected-player disruption"
