#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

bin_dir="$test_root/bin"
mkdir -p "$bin_dir"

cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:-/dev/null}"

case "${1:-} ${2:-}" in
  "ps --format")
    if [ "${MOCK_POSTGRES_RUNNING:-1}" = "1" ]; then
      printf '%s\n' dune-postgres
    fi
    ;;
  "exec dune-postgres")
    shift 2
    case "${1:-}" in
      psql)
        printf '%s\n' "${MOCK_PARTITION_COUNT:-30}"
        ;;
      pg_dump)
        ;;
      pg_restore)
        cat <<'TOC'
5; 2615 16385 SCHEMA - dune dune
212; 1259 16432 TABLE dune world_partition dune
3872; 0 16432 TABLE DATA dune world_partition dune
TOC
        ;;
      rm)
        ;;
    esac
    ;;
  "cp dune-postgres:"*)
    destination="${3:-}"
    mkdir -p "$(dirname "$destination")"
    printf '%s\n' mock-custom-archive > "$destination"
    ;;
  "cp "*)
    ;;
esac
EOF
chmod +x "$bin_dir/docker"

# A "real" secret value planted in each location a world-scope backup must
# never leak, so the test fails loudly (not just structurally) if any of
# them end up unredacted or uncredited-for in the archive.
SECRET_SIETCH_PASSWORD="s3kr1t-sietch-pw-9f2a"
SECRET_PROBE_TOKEN="probe-secret-4c11"
SECRET_FUNCOM_TOKEN="funcom-token-77bb"
SECRET_RMQ_ADMIN="rmq-admin-cred-22dd"

seed_repo_tree() {
  local root="$1"

  mkdir -p "$root/runtime/scripts" "$root/runtime/generated" "$root/runtime/secrets" \
    "$root/runtime/backups/db" "$root/runtime/backups/system"
  cp runtime/scripts/db.sh "$root/runtime/scripts/db.sh"

  cat > "$root/.env" <<EOF
SERVER_TITLE="Test Server"
SERVER_REGION="Test Region"
EOF

  cat > "$root/runtime/generated/battlegroup.env" <<'EOF'
BATTLEGROUP_ID=sh-test-1234
SERVER_IP=203.0.113.5
SERVER_IP_MODE=public
EOF

  printf '{"sietches":[{"password": "%s"}]}\n' "$SECRET_SIETCH_PASSWORD" \
    > "$root/runtime/generated/sietch-config.json"
  printf '{"server_login_password": "%s"}\n' "$SECRET_SIETCH_PASSWORD" \
    > "$root/runtime/generated/usersettings.json"
  printf 'Bgd.ServerDisplayName="Test Sietch"\nBgd.ServerLoginPassword=%s\n' "$SECRET_SIETCH_PASSWORD" \
    > "$root/runtime/generated/gameplay-profile.ini"
  printf 'DUNE_PUBLIC_PROBE_ENABLED=true\nDUNE_PUBLIC_PROBE_SECRET=%s\n' "$SECRET_PROBE_TOKEN" \
    > "$root/runtime/generated/public-probe.env"
  printf 'bgd.sh-test.admin\n%s\n' "$SECRET_RMQ_ADMIN" > "$root/runtime/generated/sietch-rmq-admin-creds"
  printf 'bgd.sh-test.admin\n%s\n' "$SECRET_RMQ_ADMIN" > "$root/runtime/generated/deepdesert-rmq-admin-creds"

  mkdir -p "$root/runtime/generated/dune-fake-k8s-serviceaccount-director-12345"
  printf 'fake-token\n' > "$root/runtime/generated/dune-fake-k8s-serviceaccount-director-12345/token"

  printf '%s\n' "$SECRET_FUNCOM_TOKEN" > "$root/runtime/secrets/funcom-token.txt"
  printf 'admin-web-secret-value\n' > "$root/runtime/secrets/admin-web-password.txt"
}

extract_archive_for() {
  local archive="$1"
  local dest="$2"
  mkdir -p "$dest"
  tar -xzf "$archive" -C "$dest"
}

# --- Case 1: backup-full includes secrets verbatim and is 600 -------------

case1_root="$test_root/case1"
mkdir -p "$case1_root/work"
seed_repo_tree "$case1_root/work"

set +e
(
  cd "$case1_root/work"
  PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$case1_root/docker.log" \
    bash runtime/scripts/db.sh backup-full
) > "$case1_root/output.log" 2>&1
case1_exit=$?
set -e

if [ "$case1_exit" -ne 0 ]; then
  echo "FAIL backup-full-happy-path: expected exit 0, got $case1_exit"
  cat "$case1_root/output.log"
  exit 1
fi

case1_archive="$(find "$case1_root/work/runtime/backups/system" -maxdepth 1 -name 'dune-system-full-*.tar.gz' | head -n1)"
if [ -z "$case1_archive" ] || [ ! -f "$case1_archive" ]; then
  echo "FAIL backup-full-happy-path: no dune-system-full-*.tar.gz archive was written"
  cat "$case1_root/output.log"
  exit 1
fi
if [ ! -f "$case1_archive.yaml" ]; then
  echo "FAIL backup-full-happy-path: archive sidecar .yaml is missing"
  exit 1
fi

case1_perms="$(stat -c '%a' "$case1_archive")"
if [ "$case1_perms" != "600" ]; then
  echo "FAIL backup-full-happy-path: expected archive mode 600, got $case1_perms"
  exit 1
fi

case1_extract="$test_root/case1-extract"
extract_archive_for "$case1_archive" "$case1_extract"

if [ ! -d "$case1_extract/secrets" ]; then
  echo "FAIL backup-full-happy-path: archive is missing secrets/ directory"
  exit 1
fi
if ! grep -q "$SECRET_FUNCOM_TOKEN" "$case1_extract/secrets/funcom-token.txt" 2>/dev/null; then
  echo "FAIL backup-full-happy-path: funcom-token.txt content missing/altered inside archive"
  exit 1
fi
if ! grep -q "$SECRET_SIETCH_PASSWORD" "$case1_extract/generated/gameplay-profile.ini" 2>/dev/null; then
  echo "FAIL backup-full-happy-path: full backup must NOT redact the sietch password"
  exit 1
fi
if [ -d "$case1_extract/generated/dune-fake-k8s-serviceaccount-director-12345" ]; then
  echo "FAIL backup-full-happy-path: ephemeral fake-k8s-serviceaccount dir should be excluded even in full scope"
  exit 1
fi
if ! grep -q 'includes_secrets: true' "$case1_archive.yaml"; then
  echo "FAIL backup-full-happy-path: sidecar does not declare includes_secrets: true"
  exit 1
fi
echo "PASS backup-full-happy-path"

# --- Case 2: backup-world excludes/redacts every planted secret -----------

case2_root="$test_root/case2"
mkdir -p "$case2_root/work"
seed_repo_tree "$case2_root/work"

set +e
(
  cd "$case2_root/work"
  PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$case2_root/docker.log" \
    bash runtime/scripts/db.sh backup-world
) > "$case2_root/output.log" 2>&1
case2_exit=$?
set -e

if [ "$case2_exit" -ne 0 ]; then
  echo "FAIL backup-world-no-secrets-leak: expected exit 0, got $case2_exit"
  cat "$case2_root/output.log"
  exit 1
fi

case2_archive="$(find "$case2_root/work/runtime/backups/system" -maxdepth 1 -name 'dune-system-world-*.tar.gz' | head -n1)"
if [ -z "$case2_archive" ] || [ ! -f "$case2_archive" ]; then
  echo "FAIL backup-world-no-secrets-leak: no dune-system-world-*.tar.gz archive was written"
  cat "$case2_root/output.log"
  exit 1
fi

case2_perms="$(stat -c '%a' "$case2_archive")"
if [ "$case2_perms" != "640" ]; then
  echo "FAIL backup-world-no-secrets-leak: expected archive mode 640, got $case2_perms"
  exit 1
fi

case2_extract="$test_root/case2-extract"
extract_archive_for "$case2_archive" "$case2_extract"

if [ -d "$case2_extract/secrets" ]; then
  echo "FAIL backup-world-no-secrets-leak: archive must not contain a secrets/ directory"
  exit 1
fi
if [ -f "$case2_extract/generated/public-probe.env" ]; then
  echo "FAIL backup-world-no-secrets-leak: public-probe.env (contains a real secret) must be excluded"
  exit 1
fi
if [ -f "$case2_extract/generated/sietch-rmq-admin-creds" ] || [ -f "$case2_extract/generated/deepdesert-rmq-admin-creds" ]; then
  echo "FAIL backup-world-no-secrets-leak: *-rmq-admin-creds files must be excluded"
  exit 1
fi
if [ -d "$case2_extract/generated/dune-fake-k8s-serviceaccount-director-12345" ]; then
  echo "FAIL backup-world-no-secrets-leak: ephemeral fake-k8s-serviceaccount dir must be excluded"
  exit 1
fi

# The decisive check: none of the four planted secret values may appear
# ANYWHERE in the extracted tree, not just in the files we know to check.
if grep -RIl -e "$SECRET_SIETCH_PASSWORD" -e "$SECRET_PROBE_TOKEN" -e "$SECRET_FUNCOM_TOKEN" -e "$SECRET_RMQ_ADMIN" "$case2_extract" 2>/dev/null | grep -q .; then
  echo "FAIL backup-world-no-secrets-leak: a planted secret value leaked into the world-scope archive"
  grep -RIl -e "$SECRET_SIETCH_PASSWORD" -e "$SECRET_PROBE_TOKEN" -e "$SECRET_FUNCOM_TOKEN" -e "$SECRET_RMQ_ADMIN" "$case2_extract" 2>/dev/null
  exit 1
fi

# The redacted files must still exist with their non-secret fields intact,
# proving this is real redaction, not a silent drop of the whole file.
if ! grep -q 'Test Sietch' "$case2_extract/generated/gameplay-profile.ini" 2>/dev/null; then
  echo "FAIL backup-world-no-secrets-leak: redaction dropped non-secret content from gameplay-profile.ini"
  exit 1
fi
if ! grep -q '\[REDACTED\]' "$case2_extract/generated/gameplay-profile.ini" 2>/dev/null; then
  echo "FAIL backup-world-no-secrets-leak: gameplay-profile.ini password line was removed instead of redacted"
  exit 1
fi
if ! grep -q '\[REDACTED\]' "$case2_extract/generated/sietch-config.json" 2>/dev/null; then
  echo "FAIL backup-world-no-secrets-leak: sietch-config.json password field was removed instead of redacted"
  exit 1
fi
if ! grep -q '\[REDACTED\]' "$case2_extract/generated/usersettings.json" 2>/dev/null; then
  echo "FAIL backup-world-no-secrets-leak: usersettings.json password field was removed instead of redacted"
  exit 1
fi
if ! grep -q 'BATTLEGROUP_ID=sh-test-1234' "$case2_extract/generated/battlegroup.env" 2>/dev/null; then
  echo "FAIL backup-world-no-secrets-leak: non-secret battlegroup.env content should be preserved verbatim"
  exit 1
fi
if ! grep -q 'includes_secrets: false' "$case2_archive.yaml"; then
  echo "FAIL backup-world-no-secrets-leak: sidecar does not declare includes_secrets: false"
  exit 1
fi
echo "PASS backup-world-no-secrets-leak"

# --- Case 3: backup-full/backup-world fail cleanly with postgres down -----

for scope_cmd in backup-full backup-world; do
  case3_root="$test_root/case3-$scope_cmd"
  mkdir -p "$case3_root/work"
  seed_repo_tree "$case3_root/work"

  set +e
  (
    cd "$case3_root/work"
    PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$case3_root/docker.log" MOCK_POSTGRES_RUNNING=0 \
      bash runtime/scripts/db.sh "$scope_cmd"
  ) > "$case3_root/output.log" 2>&1
  case3_exit=$?
  set -e

  if [ "$case3_exit" -eq 0 ]; then
    echo "FAIL $scope_cmd-fails-without-postgres: expected non-zero exit when dune-postgres is not running"
    cat "$case3_root/output.log"
    exit 1
  fi
  if find "$case3_root/work/runtime/backups/system" -maxdepth 1 -type f | grep -q .; then
    echo "FAIL $scope_cmd-fails-without-postgres: a partial/published artifact was left behind"
    find "$case3_root/work/runtime/backups/system" -maxdepth 1 -type f -print
    exit 1
  fi
  echo "PASS $scope_cmd-fails-without-postgres"
done

# --- Case 4: list-system reports written archives -------------------------

case4_root="$test_root/case4"
mkdir -p "$case4_root/work"
seed_repo_tree "$case4_root/work"

(
  cd "$case4_root/work"
  PATH="$bin_dir:$PATH" bash runtime/scripts/db.sh backup-world >/dev/null 2>&1
)

case4_output="$(cd "$case4_root/work" && PATH="$bin_dir:$PATH" bash runtime/scripts/db.sh list-system 2>&1)"
if ! printf '%s' "$case4_output" | grep -q 'dune-system-world-.*\.tar\.gz'; then
  echo "FAIL list-system-reports-archive: list-system did not report the written world archive"
  printf '%s\n' "$case4_output"
  exit 1
fi
echo "PASS list-system-reports-archive"
