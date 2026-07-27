#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/runtime/scripts/steamcmd-signals.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

dns_log="$tmp_dir/dns.log"
cat > "$dns_log" <<'EOF'
Connecting anonymously to Steam Public...OK
Error: Could not resolve host cache1-blv2.valve.org
EOF

steamcmd_log_has_dns_failure "$dns_log"
steamcmd_log_has_content_host_failure "$dns_log"
[ "$(steamcmd_dns_host_from_log "$dns_log")" = "cache1-blv2.valve.org" ]

single_source_log="$tmp_dir/single-source.log"
cat > "$single_source_log" <<'EOF'
[2026-07-24 10:00:00] Moving to source priority class '6'
[2026-07-24 10:00:00] Created download interface of type 'SteamCache' (7) to host cache1-blv2.valve.org (cache1-blv2.valve.org)
[2026-07-24 10:00:01] HTTP (SteamCache,1) - cache1-blv2.valve.org (0.0.0.0:443 / 0.0.0.0:443, host: cache1-blv2.valve.org): Received 0 (Invalid) HTTP response for depot 4754532
[2026-07-24 10:00:01] AppID 4754530 update prefetch canceled : Failed downloading 1 manifests (No connection)
EOF

steamcmd_log_has_content_host_failure "$single_source_log"
[ "$(steamcmd_source_priority_from_log "$single_source_log")" = "6" ]
[ "$(steamcmd_download_interface_count "$single_source_log")" = "1" ]
[ "$(steamcmd_dns_host_from_log "$single_source_log")" = "cache1-blv2.valve.org" ]

manifest_denied_log="$tmp_dir/manifest-denied.log"
cat > "$manifest_denied_log" <<'EOF'
[2026-07-25 19:42:42] CDepotDownloadMgr::BYldRequestDepotManifest(App: 4754530, Depot: 4754532, Manifest: 9024770243793080621, branch: ): Failed to get manifest request code, 'Access Denied'
[2026-07-25 19:42:42] AppID 4754530 update canceled : Failed downloading 1 manifests (No connection)
EOF

steamcmd_log_has_manifest_access_denied "$manifest_denied_log"
steamcmd_log_needs_manifest_repair "$manifest_denied_log"
if steamcmd_log_has_content_host_failure "$manifest_denied_log"; then
  echo "manifest access denial must take precedence over the generic no-connection line" >&2
  exit 1
fi

install_log="$tmp_dir/install.log"
cat > "$install_log" <<'EOF'
ERROR! App '4754530' state is 0x6 after update job.
EOF

if steamcmd_log_has_dns_failure "$install_log"; then
  echo "ordinary SteamCMD errors must not be classified as DNS failures" >&2
  exit 1
fi
if steamcmd_log_has_content_host_failure "$install_log"; then
  echo "ordinary SteamCMD errors must not be classified as content-host failures" >&2
  exit 1
fi
steamcmd_log_needs_manifest_repair "$install_log"

wrapper_log="$tmp_dir/wrapper.log"
cat > "$wrapper_log" <<'EOF'
[dune] Target directory: /srv/dune/server
[dune] If SteamCMD printed "state is 0x6", common causes are:
[dune]   - not enough free disk space in Docker's volume storage
This is a Steam content-host failure, not an install-directory failure.
EOF

if steamcmd_log_has_install_storage_failure "$wrapper_log"; then
  echo "updater help text must not be classified as an install/storage failure" >&2
  exit 1
fi

storage_log="$tmp_dir/storage.log"
cat > "$storage_log" <<'EOF'
Error: failed to write /srv/dune/server/steamapps/appmanifest_4754530.acf: No space left on device
EOF
steamcmd_log_has_install_storage_failure "$storage_log"
if steamcmd_log_needs_manifest_repair "$storage_log"; then
  echo "a positive storage failure must not trigger manifest repair" >&2
  exit 1
fi

cdn_state_log="$tmp_dir/cdn-state.log"
cat "$single_source_log" > "$cdn_state_log"
printf "Error! App '4754530' state is 0x6 after update job.\n" >> "$cdn_state_log"
if steamcmd_log_needs_manifest_repair "$cdn_state_log"; then
  echo "a positive content-host failure must not trigger manifest repair" >&2
  exit 1
fi

echo "SteamCMD content-host failure signals detected correctly"
