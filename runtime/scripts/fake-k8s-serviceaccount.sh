#!/usr/bin/env bash

# Funcom services expect Kubernetes service-account files even when running
# directly in Docker. Keep one stable directory per workload and remove only
# legacy PID-suffixed directories that no Docker container still references.

fake_k8s_serviceaccount_dir() {
  local workload_key="$1"

  if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
    printf '%s\n' "$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
    return 0
  fi

  case "$workload_key" in
    ''|*[!a-z0-9-]*)
      echo "Invalid fake Kubernetes service-account workload key: $workload_key" >&2
      return 1
      ;;
  esac

  printf '%s/runtime/generated/dune-fake-k8s-serviceaccount-%s\n' "$PWD" "$workload_key"
}

prepare_fake_k8s_serviceaccount() {
  local directory="$1"
  local namespace="$2"
  local generated_root="$PWD/runtime/generated"

  # Publish the sibling marker before creating the directory so another map
  # launcher cannot mistake a concurrently prepared stable path for legacy.
  case "$directory" in
    "$generated_root"/dune-fake-k8s-serviceaccount-*)
      mkdir -p "$generated_root"
      : > "${directory}.stable"
      chmod 600 "${directory}.stable"
      ;;
  esac

  mkdir -p "$directory"
  printf '%s\n' "$namespace" > "$directory/namespace"
  printf '%s\n' 'fake-token' > "$directory/token"

  # An empty CA intentionally makes IGWO initialization fail non-fatally
  # instead of calling a Kubernetes API that does not exist in Docker mode.
  : > "$directory/ca.crt"
  chmod 755 "$directory" "$directory/namespace" "$directory/token" "$directory/ca.crt"
}

prune_legacy_fake_k8s_serviceaccounts() {
  local generated_root="$PWD/runtime/generated"
  local container_output mount_output candidate candidate_host mounted_source
  local -a container_ids=()
  local -a mounted_sources=()
  local -a candidates=()
  local -A mounted_source_lookup=()

  [ -d "$generated_root" ] || return 0
  command -v docker >/dev/null 2>&1 || return 0

  if ! container_output="$(docker ps -aq 2>/dev/null)"; then
    return 0
  fi
  if [ -n "$container_output" ]; then
    mapfile -t container_ids <<< "$container_output"
  fi
  if [ "${#container_ids[@]}" -gt 0 ]; then
    if ! mount_output="$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "${container_ids[@]}" 2>/dev/null)"; then
      # Fail closed: without a complete mount inventory, nothing is safe to
      # remove because even a stopped container may be started again.
      return 0
    fi
    mapfile -t mounted_sources <<< "$mount_output"
  fi

  for mounted_source in "${mounted_sources[@]}"; do
    [ -n "$mounted_source" ] || continue
    if command -v realpath >/dev/null 2>&1; then
      if ! mounted_source="$(realpath -m -- "$mounted_source" 2>/dev/null)"; then
        return 0
      fi
    fi
    mounted_source_lookup["$mounted_source"]=1
  done

  shopt -s nullglob
  candidates=("$generated_root"/dune-fake-k8s-serviceaccount-*)
  shopt -u nullglob

  for candidate in "${candidates[@]}"; do
    [ -d "$candidate" ] || continue
    [ ! -e "${candidate}.stable" ] || continue

    candidate_host="$candidate"
    if declare -F host_path >/dev/null 2>&1; then
      candidate_host="$(host_path "$candidate")" || return 0
    fi
    if command -v realpath >/dev/null 2>&1; then
      if ! candidate_host="$(realpath -m -- "$candidate_host" 2>/dev/null)"; then
        return 0
      fi
    fi

    [ -z "${mounted_source_lookup["$candidate_host"]+present}" ] || continue

    case "$candidate" in
      "$generated_root"/dune-fake-k8s-serviceaccount-*)
        if ! rm -rf -- "$candidate"; then
          echo "Warning: could not remove stale fake Kubernetes service-account directory: $candidate" >&2
        fi
        ;;
    esac
  done

  return 0
}
