#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

grep -Fq 'director_heal_due proactive_hagga "$PROACTIVE_HAGGA_SCAN_SECONDS"' "$script"
grep -Fq 'director_heal_due deepdesert_loading "$DEEPDESERT_LOADING_SCAN_SECONDS"' "$script"
grep -Fq 'director_heal_due named_destination_failures "$NAMED_DESTINATION_SCAN_SECONDS"' "$script"
grep -Fq 'PROACTIVE_HAGGA_SCAN_SECONDS="${DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS:-15}"' "$script"
grep -Fq 'DEEPDESERT_LOADING_SCAN_SECONDS="${DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS:-15}"' "$script"
grep -Fq 'NAMED_DESTINATION_SCAN_SECONDS="${DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS:-60}"' "$script"

# Static check: the gate must be the first non-"local" statement in each
# scan function, so a revert or a gate moved after the docker-logs/side-effect
# work it's meant to guard would fail this assertion.
python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")

checks = [
    ("scan_proactive_hagga_handoffs()",
     'director_heal_due proactive_hagga "$PROACTIVE_HAGGA_SCAN_SECONDS" || return 0'),
    ("scan_deepdesert_loading_responses()",
     'director_heal_due deepdesert_loading "$DEEPDESERT_LOADING_SCAN_SECONDS" || return 0'),
    ("scan_named_destination_failures()",
     'director_heal_due named_destination_failures "$NAMED_DESTINATION_SCAN_SECONDS" || return 0'),
]

for fn, gate_line in checks:
    start = text.index(fn)
    end = text.index("\n}\n", start)
    body = text[start:end]
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    non_local = [l for l in lines[1:] if not l.startswith("local ")]
    assert non_local, f"{fn}: function body has no statements after locals"
    assert non_local[0] == gate_line, (
        f"{fn}: expected gate as first statement, got {non_local[0]!r}"
    )
PY

# Dynamic check: director_heal_due itself must actually rate-limit (return
# non-zero within the interval, fire again once it has elapsed). This exercises
# the real gating logic these three scans now depend on, rather than only
# asserting the gate line's text is present. Everything before the
# background-follower/main-loop tail is pure function/variable definitions,
# so it's safe to source in isolation once state files are redirected to a
# scratch directory and the script's own repo-root `cd` (meant for direct
# execution, not sourcing) is stripped.
tail_line="$(grep -n '^follow_director_hagga_handoffs &' "$script" | head -n1 | cut -d: -f1)"
[ -n "$tail_line" ] || { echo "could not find main-loop tail marker in $script" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

defs_file="$work_dir/autoscaler-defs.sh"
sed -n "1,$((tail_line - 1))p" "$script" | sed '/^cd "\$(dirname "\$0")\/\.\.\/\.\."$/d' > "$defs_file"

(
  set -euo pipefail
  export DUNE_AUTOSCALER_STATE_FILE="$work_dir/idle.tsv"
  export DUNE_AUTOSCALER_SERVER_ID_MAP_FILE="$work_dir/server-ids.tsv"
  export DUNE_AUTOSCALER_DEMAND_FILE="$work_dir/demand.tsv"
  export DUNE_AUTOSCALER_DEMAND_EVENT_FILE="$work_dir/demand-events.tsv"
  export DUNE_AUTOSCALER_HUB_TRAVEL_FILE="$work_dir/hub-travel.tsv"
  export DUNE_AUTOSCALER_DEEPDESERT_TRAVEL_FILE="$work_dir/deepdesert-travel.tsv"
  export DUNE_AUTOSCALER_DIRECTOR_HEAL_FILE="$work_dir/director-heal.tsv"

  # The script's own top-level preflight (before the main-loop tail this file
  # stops at) requires `docker ps` to list dune-director/dune-postgres or it
  # exits 1. Stub it so sourcing succeeds without a real Docker daemon; no
  # function this test actually calls (director_heal_due/get/set) shells out
  # to docker.
  docker() { echo "dune-director"; echo "dune-postgres"; }

  # shellcheck source=/dev/null
  source "$defs_file" >/dev/null

  if ! director_heal_due rate_limit_smoke_test 100; then
    echo "expected first director_heal_due call to be due" >&2
    exit 1
  fi

  if director_heal_due rate_limit_smoke_test 100; then
    echo "expected second director_heal_due call within the interval to be gated" >&2
    exit 1
  fi

  director_heal_set "scan:rate_limit_smoke_test" "$(( $(date +%s) - 200 ))"
  if ! director_heal_due rate_limit_smoke_test 100; then
    echo "expected director_heal_due to fire again once the interval elapsed" >&2
    exit 1
  fi
)

echo "autoscaler gates proactive-hagga, deep-desert-loading, and named-destination heal scans behind director_heal_due, and director_heal_due itself rate-limits correctly"
