#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/project/runtime/scripts" "$test_root/project/runtime/generated"
cp "$repo_root/runtime/scripts/memory.sh" "$test_root/project/runtime/scripts/memory.sh"

cat > "$test_root/project/runtime/generated/partition-catalog.json" <<'EOF'
[
  {"id": 1, "map": "Survival_1", "dimension": 0},
  {"id": 31, "map": "Survival_1", "dimension": 1},
  {"id": 2, "map": "Overmap", "dimension": 0},
  {"id": 8, "map": "DeepDesert_1", "dimension": 0},
  {"id": 30, "map": "CB_Dungeon_ThePit", "dimension": 0}
]
EOF

cat > "$test_root/project/runtime/generated/server-catalog.json" <<'EOF'
[
  {"map": "Survival_1", "resources": {"limits": {"memory": "12Gi"}}},
  {"map": "Overmap", "resources": {"limits": {"memory": "2Gi"}}},
  {"map": "DeepDesert_1", "resources": {"limits": {"memory": "15Gi"}}},
  {"map": "CB_Dungeon_ThePit", "resources": {"limits": {"memory": "2Gi"}}}
]
EOF

output="$(cd "$test_root/project" && bash runtime/scripts/memory.sh status)"

grep -Eq '^Survival_1[[:space:]]+16g default$' <<<"$output"
grep -Eq '^Overmap[[:space:]]+3g default$' <<<"$output"
grep -Eq '^DeepDesert_1[[:space:]]+16g default$' <<<"$output"
grep -Eq '^CB_Dungeon_ThePit[[:space:]]+2Gi default$' <<<"$output"
grep -Eq '^Survival_1:1[[:space:]]+16g default$' <<<"$output"
grep -Eq '^Survival_1:31[[:space:]]+16g default$' <<<"$output"

cat > "$test_root/project/.env" <<'EOF'
DUNE_MEMORY_DEFAULT=4g
DUNE_MEMORY_SURVIVAL_1=14g
DUNE_MEMORY_PARTITION_1=12g
EOF

output="$(cd "$test_root/project" && bash runtime/scripts/memory.sh status)"

grep -Eq '^Survival_1[[:space:]]+14g$' <<<"$output"
grep -Eq '^Survival_1:1[[:space:]]+12g$' <<<"$output"
grep -Eq '^Survival_1:31[[:space:]]+14g$' <<<"$output"
grep -Eq '^Overmap[[:space:]]+3g default$' <<<"$output"
grep -Eq '^DeepDesert_1[[:space:]]+4g$' <<<"$output"
grep -Eq '^CB_Dungeon_ThePit[[:space:]]+4g$' <<<"$output"

echo "memory status reports effective launcher defaults and preserves override precedence"
