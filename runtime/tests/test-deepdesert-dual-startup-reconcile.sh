#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

override="$tmpdir/director-deepdesert-dual.ini"

cat > "$override" <<'EOF'
[DeepDesert_1]
NumExtraServers=1
MinServers=0
EOF

DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh dual configured >/dev/null

cat > "$override" <<'EOF'
; ManagedPvpPartition=8
; ManagedPvePartition=42

[DeepDesert_1]
NumExtraServers=1
MinServers=0
EOF

DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh dual configured >/dev/null

cat > "$override" <<'EOF'
[DeepDesert_1]
NumExtraServers=0
MinServers=0
EOF

if DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh dual configured >/dev/null 2>&1; then
  echo "FAIL: a zero-extra-server override was treated as Dual Deep Desert" >&2
  exit 1
fi

rm -f "$override"
if DUNE_DEEPDESERT_OVERRIDE_FILE="$override" runtime/scripts/deepdesert.sh dual configured >/dev/null 2>&1; then
  echo "FAIL: a missing override was treated as Dual Deep Desert" >&2
  exit 1
fi

db_line="$(grep -n 'run_timed_step "Ensuring Database Is Up To Date"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"
repair_line="$(grep -n 'run_timed_step "Reconciling Dual Deep Desert"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"
director_line="$(grep -n 'run_timed_step "Starting Director"' runtime/scripts/start-all.sh | head -n1 | cut -d: -f1)"

if [ -z "$db_line" ] || [ -z "$repair_line" ] || [ -z "$director_line" ]; then
  echo "FAIL: could not locate the Dual Deep Desert startup reconciliation sequence" >&2
  exit 1
fi

if [ "$repair_line" -le "$db_line" ] || [ "$repair_line" -ge "$director_line" ]; then
  echo "FAIL: Dual Deep Desert must reconcile after database migration and before Director startup" >&2
  exit 1
fi

echo "PASS: configured Dual Deep Desert is reconciled after database migration and before Director startup"
