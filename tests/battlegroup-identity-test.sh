#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TEST_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

make_token() {
  local host_id="$1"
  local output="$2"
  HOST_ID="$host_id" python3 - "$output" <<'PY'
import base64
import json
import os
import sys

payload = base64.urlsafe_b64encode(json.dumps({"HostId": os.environ["HOST_ID"]}).encode()).decode().rstrip("=")
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(f"header.{payload}.signature\n")
PY
}

run_identity() {
  DUNE_BATTLEGROUP_FILE="$1" \
  DUNE_FUNCOM_TOKEN_FILE="$2" \
  DUNE_BATTLEGROUP_PRIMARY_ENV_FILE="$(dirname "$1")/primary.env" \
  DUNE_BATTLEGROUP_BACKUP_DIR="$3" \
  DUNE_BATTLEGROUP_INIT_BACKUP_DIR="$4" \
  DUNE_BATTLEGROUP_SKIP_RUNTIME_SOURCES=1 \
    runtime/scripts/battlegroup-identity.sh "${5:-ensure}"
}

case_root="$TEST_ROOT/recover"
mkdir -p "$case_root/backups" "$case_root/init"
printf 'SERVER_IP=203.0.113.10\nSERVER_IP_MODE=public\n' > "$case_root/battlegroup.env"
make_token "32C81B95425F1320" "$case_root/token.txt"
cat > "$case_root/backups/latest.backup.yaml" <<'EOF'
backup_origin: automatic
battlegroup_id: sh-32c81b95425f1320-qtlepg
EOF
run_identity "$case_root/battlegroup.env" "$case_root/token.txt" "$case_root/backups" "$case_root/init" >/dev/null
grep -qx 'BATTLEGROUP_ID=sh-32c81b95425f1320-qtlepg' "$case_root/battlegroup.env" || fail "missing identity was not recovered"
grep -qx 'SERVER_IP=203.0.113.10' "$case_root/battlegroup.env" || fail "identity recovery discarded existing settings"
run_identity "$case_root/battlegroup.env" "$case_root/token.txt" "$case_root/backups" "$case_root/init" check >/dev/null
pass "missing identity recovers from token-matching backup metadata"

case_root="$TEST_ROOT/primary-env"
mkdir -p "$case_root/backups" "$case_root/init"
printf 'SERVER_IP_MODE=local\n' > "$case_root/battlegroup.env"
printf 'BATTLEGROUP_ID=sh-eeeeeeeeeeeeeeee-configured\n' > "$case_root/primary.env"
make_token "eeeeeeeeeeeeeeee" "$case_root/token.txt"
run_identity "$case_root/battlegroup.env" "$case_root/token.txt" "$case_root/backups" "$case_root/init" >/dev/null
grep -qx 'BATTLEGROUP_ID=sh-eeeeeeeeeeeeeeee-configured' "$case_root/battlegroup.env" || fail "identity was not recovered from .env"
pass "missing generated identity recovers from token-matching primary configuration"

case_root="$TEST_ROOT/mismatch"
mkdir -p "$case_root/backups" "$case_root/init"
printf 'BATTLEGROUP_ID=sh-aaaaaaaaaaaaaaaa-original\nSERVER_IP=203.0.113.11\n' > "$case_root/battlegroup.env"
make_token "bbbbbbbbbbbbbbbb" "$case_root/token.txt"
printf 'battlegroup_id: sh-bbbbbbbbbbbbbbbb-other\n' > "$case_root/backups/latest.backup.yaml"
if run_identity "$case_root/battlegroup.env" "$case_root/token.txt" "$case_root/backups" "$case_root/init" >/dev/null 2>&1; then
  fail "mismatched configured identity was replaced automatically"
fi
grep -qx 'BATTLEGROUP_ID=sh-aaaaaaaaaaaaaaaa-original' "$case_root/battlegroup.env" || fail "mismatched identity was modified"
pass "configured identity mismatch fails closed without replacement"

case_root="$TEST_ROOT/no-evidence"
mkdir -p "$case_root/backups" "$case_root/init"
printf 'SERVER_IP=203.0.113.12\n' > "$case_root/battlegroup.env"
make_token "cccccccccccccccc" "$case_root/token.txt"
if run_identity "$case_root/battlegroup.env" "$case_root/token.txt" "$case_root/backups" "$case_root/init" >/dev/null 2>&1; then
  fail "identity without recovery evidence was accepted"
fi
if grep -q 'dune-docker' "$case_root/battlegroup.env"; then
  fail "unsafe placeholder identity was persisted"
fi
pass "missing identity without evidence refuses the dune-docker fallback"

concurrent_file="$TEST_ROOT/concurrent.env"
printf 'BATTLEGROUP_ID=sh-dddddddddddddddd-stable\nA=0\nB=0\n' > "$concurrent_file"
TARGET_FILE="$concurrent_file" bash -c 'source runtime/scripts/env-file.sh; for i in $(seq 1 50); do set_env_file_value "$TARGET_FILE" A "$i" 664; done' &
first_pid=$!
TARGET_FILE="$concurrent_file" bash -c 'source runtime/scripts/env-file.sh; for i in $(seq 1 50); do set_env_file_value "$TARGET_FILE" B "$i" 664; done' &
second_pid=$!
wait "$first_pid" "$second_pid"
grep -qx 'BATTLEGROUP_ID=sh-dddddddddddddddd-stable' "$concurrent_file" || fail "concurrent writes discarded the identity"
grep -qx 'A=50' "$concurrent_file" || fail "first concurrent writer did not finish"
grep -qx 'B=50' "$concurrent_file" || fail "second concurrent writer did not finish"
pass "locked atomic environment updates preserve unrelated keys"

printf '\nBattlegroup identity tests passed.\n'
