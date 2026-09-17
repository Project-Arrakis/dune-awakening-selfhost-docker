#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mock_pg_dump="$tmp_dir/pg_dump"
arguments_file="$tmp_dir/arguments"

cat > "$mock_pg_dump" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGUMENTS_FILE"
EOF
chmod +x "$mock_pg_dump"

MOCK_ARGUMENTS_FILE="$arguments_file" DUNE_REAL_PG_DUMP="$mock_pg_dump" \
  runtime/scripts/db-update-pg-dump -d dune --schema-only
grep -Fxq -- '--schema=dune' "$arguments_file"
grep -Fxq -- '--schema=ext' "$arguments_file"
grep -Fxq -- '--schema=public' "$arguments_file"
grep -Fxq -- '--schema-only' "$arguments_file"
if grep -Fq -- '--exclude-schema=' "$arguments_file"; then
  echo "FAIL schema validation must use a Funcom-owned allowlist" >&2
  exit 1
fi
echo "PASS schema validation includes only Funcom-owned schemas"

MOCK_ARGUMENTS_FILE="$arguments_file" DUNE_REAL_PG_DUMP="$mock_pg_dump" \
  runtime/scripts/db-update-pg-dump -d dune --data-only
if grep -Eq -- '--(exclude-)?schema=' "$arguments_file"; then
  echo "FAIL ordinary database dumps must include every schema" >&2
  exit 1
fi
grep -Fxq -- '--data-only' "$arguments_file"
echo "PASS ordinary database dumps remain complete"
