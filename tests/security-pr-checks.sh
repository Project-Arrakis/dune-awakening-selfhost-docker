#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${BASE_REF:-upstream/main}"
# SCAN_MODE selects what is scanned:
#   changed (default)  only the files this branch changed relative to BASE_REF. Right for pull requests.
#   full               every tracked file. Right for a push to main (and integration/release branches),
#                      where HEAD *is* BASE_REF, so the changed set is empty by construction and a
#                      changed-file scan would scan nothing: gitleaks "scanned ~0 bytes" and trivy
#                      "no changed files" on every merge (found by the hourly monitor's scanner-skip check).
SCAN_MODE="${SCAN_MODE:-changed}"
case "$SCAN_MODE" in
  changed|full) ;;
  *) printf 'ERROR: SCAN_MODE must be "changed" or "full" (got: %s)\n' "$SCAN_MODE" >&2; exit 1 ;;
esac
if [ "$SCAN_MODE" = "full" ]; then SCAN_LABEL="full-tree"; else SCAN_LABEL="changed-file"; fi
REPORT_DIR="${REPORT_DIR:-.security-reports}"
PR_FILES_DIR="$REPORT_DIR/pr-files"
REPO_ROOT_FOR_GITLEAKS_CONFIG="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

printf 'Security check base ref: %s\n' "$BASE_REF"
printf 'Scan mode: %s\n' "$SCAN_MODE"
printf 'Report directory: %s\n' "$REPORT_DIR"
printf 'Changed-file staging directory: %s\n\n' "$PR_FILES_DIR"

mkdir -p "$REPORT_DIR"

printf '== Git whitespace/conflict check ==\n'
# Runs in BOTH modes. On a push to main HEAD is BASE_REF, so the diff is empty and this passes trivially; on a
# push to integration/** or release/** (also SCAN_MODE=full) HEAD differs from origin/main and leftover conflict
# markers or whitespace errors from a bad merge are real, and neither gitleaks nor trivy would catch them.
git diff --check "$BASE_REF"...HEAD

if [ "$SCAN_MODE" = "full" ]; then
  printf '\n== Files to scan (full mode: every tracked file) ==\n'
  git ls-files > "$REPORT_DIR/changed-files.txt"
  printf 'Tracked files: %s\n' "$(wc -l < "$REPORT_DIR/changed-files.txt" | tr -d ' ')"
else
  printf '\n== Changed files ==\n'
  git diff --name-only "$BASE_REF"...HEAD --diff-filter=ACM | tee "$REPORT_DIR/changed-files.txt"
fi

printf '\n== Preparing changed-file scan set ==\n'
rm -rf "$PR_FILES_DIR"
mkdir -p "$PR_FILES_DIR"

while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue

  mkdir -p "$PR_FILES_DIR/$(dirname "$file")"
  cp "$file" "$PR_FILES_DIR/$file"
done < "$REPORT_DIR/changed-files.txt"

if [ ! -d "$PR_FILES_DIR" ]; then
  printf 'ERROR: changed-file staging directory was not created: %s\n' "$PR_FILES_DIR" >&2
  exit 1
fi

printf 'Copied files into: %s\n' "$PR_FILES_DIR"
if [ "$SCAN_MODE" = "full" ]; then
  find "$PR_FILES_DIR" -type f | sort > "$REPORT_DIR/staged-files.txt"
  printf 'Staged files: %s\n' "$(wc -l < "$REPORT_DIR/staged-files.txt" | tr -d ' ')"
  if [ ! -s "$REPORT_DIR/staged-files.txt" ]; then
    printf 'ERROR: full scan staged no files; refusing to report a clean scan of nothing.\n' >&2
    exit 1
  fi
else
  find "$PR_FILES_DIR" -type f | sort | tee "$REPORT_DIR/staged-files.txt"
fi

printf '\n== Secret keyword review on changed files ==\n'
if [ "$SCAN_MODE" = "full" ]; then
  printf 'Skipped in full mode (an informational grep over a branch diff; gitleaks and trivy cover the whole tree below).\n' | tee "$REPORT_DIR/secret-keyword-review.txt"
elif [ -s "$REPORT_DIR/staged-files.txt" ]; then
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -HnE '(password|passwd|secret|token|apikey|api_key|private[_-]?key|BEGIN RSA|BEGIN OPENSSH|FUNCOM|FLS|COMMAND_AUTH_TOKEN)' "$file" || true
  done < "$REPORT_DIR/staged-files.txt" | tee "$REPORT_DIR/secret-keyword-review.txt"
else
  printf 'No changed files to scan.\n' | tee "$REPORT_DIR/secret-keyword-review.txt"
fi

printf '\n== ShellCheck ==\n'
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    runtime/scripts/dune \
    runtime/scripts/metrics-stack.sh \
    runtime/scripts/metrics-status.sh \
    tests/metrics-stack-unit.sh \
    tests/security-pr-checks.sh \
    runtime/scripts/lib/secrets.sh \
    runtime/scripts/lib/console-secrets-env.sh \
    runtime/scripts/secrets-cli.sh \
    runtime/scripts/console.sh \
    runtime/scripts/self-update.sh \
    runtime/tests/test-secrets-lib.sh \
    runtime/tests/test-secrets-aead-cross-language.sh \
    runtime/tests/test-secrets-stage2.sh \
    runtime/tests/test-secrets-stage3.sh
else
  printf 'SKIP: shellcheck is not installed.\n'
fi

printf '\n== Gitleaks %s scan ==\n' "$SCAN_LABEL"
if command -v gitleaks >/dev/null 2>&1; then
  # BUG FIX: this scan runs against a copied staging directory
  # ($PR_FILES_DIR), not the real git working tree, so gitleaks' default
  # config discovery (which looks for .gitleaks.toml relative to
  # --source) never found this repo's real .gitleaks.toml -- meaning the
  # project's own allowlist (e.g. the intentionally-hardcoded, documented
  # RabbitMQ command-auth fallback constant) was silently ignored here,
  # even though the same string is correctly allowlisted by every other
  # gitleaks invocation in this project (pre-commit hook, pre-push gate).
  # This caused false-positive blocks on legitimate, already-allowlisted
  # content purely because of which scan path happened to touch it.
  GITLEAKS_CONFIG_ARGS=()
  if [ -f "$REPO_ROOT_FOR_GITLEAKS_CONFIG/.gitleaks.toml" ]; then
    GITLEAKS_CONFIG_ARGS=(--config "$REPO_ROOT_FOR_GITLEAKS_CONFIG/.gitleaks.toml")
  fi
  GITLEAKS_NO_GIT_ARGS=()
  if gitleaks detect --help 2>/dev/null | grep -q -- '--no-git'; then
    GITLEAKS_NO_GIT_ARGS=(--no-git)
  fi

  # An explicit custom config replaces Gitleaks' built-in rules unless it
  # opts into them with [extend] useDefault = true. Guard against silently
  # turning this security gate into an allowlist-only, zero-rule scan.
  if [ "${#GITLEAKS_CONFIG_ARGS[@]}" -gt 0 ]; then
    GITLEAKS_CONFIG_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dune-gitleaks-config.XXXXXX")"
    trap 'rm -rf "${GITLEAKS_CONFIG_TEST_DIR:-}"' EXIT
    printf 'api_key = "%s%s"\n' \
      'a9F3kLm7Qp2Wx8Vz4Nc6' \
      'Rt1Yu5Hs0De9Bj7Gi3Ko' \
      >"$GITLEAKS_CONFIG_TEST_DIR/synthetic-secret.txt"
    if gitleaks detect \
      --source "$GITLEAKS_CONFIG_TEST_DIR" \
      "${GITLEAKS_NO_GIT_ARGS[@]}" \
      "${GITLEAKS_CONFIG_ARGS[@]}" \
      --redact \
      --no-banner \
      >/dev/null 2>&1; then
      printf 'ERROR: repository Gitleaks config did not detect the synthetic secret fixture.\n' >&2
      exit 1
    fi
    rm -rf "$GITLEAKS_CONFIG_TEST_DIR"
    GITLEAKS_CONFIG_TEST_DIR=""
    trap - EXIT
    printf 'Gitleaks repository config retains the built-in detection rules.\n'
  fi

  if [ "${#GITLEAKS_NO_GIT_ARGS[@]}" -gt 0 ]; then
    GITLEAKS_CMD=(gitleaks detect --source "$PR_FILES_DIR" --no-git "${GITLEAKS_CONFIG_ARGS[@]}" --redact --report-format json --report-path "$REPORT_DIR/gitleaks-pr-files.json")
  else
    GITLEAKS_CMD=(gitleaks detect --source "$PR_FILES_DIR" "${GITLEAKS_CONFIG_ARGS[@]}" --redact --report-format json --report-path "$REPORT_DIR/gitleaks-pr-files.json")
  fi

  if "${GITLEAKS_CMD[@]}"; then
    printf 'Gitleaks %s scan passed.\n' "$SCAN_LABEL"
  else
    printf 'Gitleaks %s scan found findings. See %s\n' "$SCAN_LABEL" "$REPORT_DIR/gitleaks-pr-files.json" >&2
    exit 1
  fi
elif [ "${CI:-}" = "true" ]; then
  printf 'ERROR: gitleaks is not installed on this CI runner -- the secret scan did not run. Install it in the workflow before calling this script.\n' >&2
  exit 1
else
  printf 'SKIP: gitleaks is not installed.\n'
fi

printf '\n== Trivy filesystem scan ==\n'
if [ ! -d "$PR_FILES_DIR" ]; then
  printf 'ERROR: Trivy staging directory missing before scan: %s\n' "$PR_FILES_DIR" >&2
  exit 1
fi

# Path-scoped, justified, expiring acceptances for the full-tree scan live in .trivyignore-fs.yaml
# (a blanket rule ID ignore would blind the scan to every future Dockerfile).
TRIVY_IGNORE_ARGS=()
if [ -f "$REPO_ROOT_FOR_GITLEAKS_CONFIG/.trivyignore-fs.yaml" ]; then
  TRIVY_IGNORE_ARGS=(--ignorefile "$REPO_ROOT_FOR_GITLEAKS_CONFIG/.trivyignore-fs.yaml")
fi

if ! find "$PR_FILES_DIR" -type f -print -quit | grep -q .; then
  # Benign: a branch whose diff has no added/changed files (e.g. a deletion-only PR). NOT the "tool missing"
  # case below, so it must not read as a skipped scanner to the hourly monitor.
  printf 'NOTE: no changed files to scan in %s (nothing to do for this diff).\n' "$PR_FILES_DIR"
elif command -v trivy >/dev/null 2>&1; then
  printf 'Running Trivy (%s) against: %s\n' "$SCAN_LABEL" "$PR_FILES_DIR"
  # --exit-code 1: trivy exits 0 even when it reports findings unless told otherwise, so without it this
  # step printed HIGH findings and the job still passed (found 2026-10-07 by planting a root Dockerfile).
  trivy fs --scanners secret,misconfig --severity HIGH,CRITICAL --exit-code 1 "${TRIVY_IGNORE_ARGS[@]}" "$PR_FILES_DIR"
elif [ "${CI:-}" = "true" ]; then
  printf 'ERROR: trivy is not installed on this CI runner -- the filesystem scan did not run. Install it in the workflow before calling this script.\n' >&2
  exit 1
else
  printf 'SKIP: trivy is not installed.\n'
fi

printf '\nSecurity checks completed.\n'
