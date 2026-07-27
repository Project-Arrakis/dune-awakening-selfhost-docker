#!/usr/bin/env bash

steamcmd_log_has_dns_failure() {
  local log_file="$1"

  grep -Eiq \
    'could not resolve host|failed to resolve|resolve[^[:space:]]*[[:space:]]+(failed|failure)|temporary failure in name resolution|name or service not known|no address associated with hostname|nodename nor servname provided|nxdomain|getaddrinfo[^[:space:]]*[[:space:]]+(failed|failure)|gethostbyname[^[:space:]]*[[:space:]]+(failed|failure)' \
    "$log_file"
}

steamcmd_log_has_manifest_access_denied() {
  local log_file="$1"

  grep -Eiq \
    "(depot manifest|manifest request code).*(access denied)|access denied.*(depot manifest|manifest request code)" \
    "$log_file"
}

steamcmd_log_has_content_host_failure() {
  local log_file="$1"

  # Steam reports a rejected stale depot manifest as "No connection" later in
  # the same attempt. Prefer the actionable manifest repair over CDN retries.
  steamcmd_log_has_manifest_access_denied "$log_file" && return 1

  steamcmd_log_has_dns_failure "$log_file" \
    || grep -Eiq \
      'received 0 \(invalid\) http response|failed downloading [0-9]+ manifests? \(no connection\)|openconnection.*(failed|failure)|connection (timed out|timeout)' \
      "$log_file"
}

steamcmd_log_has_install_storage_failure() {
  local log_file="$1"

  grep -Eiq \
    'disk write failure|no space left on device|not enough disk space|force_install_dir.*(failed|failure|error|denied)|install folder.*(failed|failure|error|denied)|permission denied.*(/srv/dune|/home/dune|steamapps|appmanifest)|(/srv/dune|/home/dune|steamapps|appmanifest).*permission denied' \
    "$log_file"
}

steamcmd_log_needs_manifest_repair() {
  local log_file="$1"

  steamcmd_log_has_manifest_access_denied "$log_file" && return 0
  steamcmd_log_has_content_host_failure "$log_file" && return 1
  steamcmd_log_has_install_storage_failure "$log_file" && return 1

  grep -Eiq \
    "App '[^']+' state is 0x6|appmanifest_[0-9]+\.acf|SteamCMD cache/metadata is stale" \
    "$log_file"
}

steamcmd_dns_host_from_log() {
  local log_file="$1"

  grep -Eio '([[:alnum:]-]+\.)+(valve\.org|steampowered\.com|steamcontent\.com|akamaihd\.net)' "$log_file" \
    | tail -n 1 \
    | tr '[:upper:]' '[:lower:]' \
    || true
}

steamcmd_source_priority_from_log() {
  local log_file="$1"

  sed -n "s/.*Moving to source priority class '\([0-9][0-9]*\)'.*/\1/p" "$log_file" \
    | tail -n 1 \
    || true
}

steamcmd_download_interface_count() {
  local log_file="$1"

  grep -c "Created download interface of type" "$log_file" || true
}
