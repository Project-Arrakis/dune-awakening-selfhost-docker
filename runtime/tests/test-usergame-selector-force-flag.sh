#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cat > "$tmpdir/gameplay-profile.ini" <<'EOF'
[Global:/Script/DuneSandbox.PvpPveSettings]
m_bShouldForceEnablePvpOnAllPartitions=False
+m_PvpEnabledPartitions=46

[Global:/Script/DuneSandbox.DuneGameMode]
bServerPVE=False
EOF

mkdir -p "$tmpdir/Saved"
DUNE_GAMEPLAY_PROFILE="$tmpdir/gameplay-profile.ini" \
DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py materialize Overmap "$tmpdir/Saved" 2

usergame="$tmpdir/Saved/UserSettings/UserGame.ini"
grep -Fqx 'm_bShouldForceEnablePvpOnAllPartitions=False' "$usergame" || {
  echo 'FAIL: mixed partition selectors did not materialize the explicit force-PvP-all=False guard' >&2
  exit 1
}
grep -Fqx '+m_PvpEnabledPartitions=46' "$usergame" || {
  echo 'FAIL: mixed partition selector was not materialized for Overland' >&2
  exit 1
}

cat > "$tmpdir/gameplay-profile.ini" <<'EOF'
[Global:/Script/DuneSandbox.DuneGameMode]
bServerPVE=True
EOF
DUNE_GAMEPLAY_PROFILE="$tmpdir/gameplay-profile.ini" \
DUNE_USERSETTINGS_CONFIG="$tmpdir/usersettings.json" \
  python3 runtime/scripts/usersettings.py materialize Overmap "$tmpdir/Saved" 2
if grep -Fq 'm_bShouldForceEnablePvpOnAllPartitions=' "$usergame"; then
  echo 'FAIL: ordinary layouts received an unnecessary force-PvP-all override' >&2
  exit 1
fi

echo 'PASS: mixed layouts materialize their explicit Kanly guard without changing ordinary layouts'
