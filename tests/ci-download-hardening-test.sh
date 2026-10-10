#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1158 and #1197: a required CI job
# (trivy-image-scan) installed trivy by piping install.sh from the mutable `main` branch into
# `sh`, with no checksum on what it then downloaded, and the console image downloaded the Docker
# CLI and Compose the same way. Every tool install pins a release URL and verifies a sha256.
#
# For EVERY curl or wget command in EVERY workflow file (.yml and .yaml) and EVERY Dockerfile
# (backslash continuations are joined first; the tool may be written with a path, e.g.
# /usr/bin/curl) this fails when the command:
#   - feeds a shell or interpreter (a pipe into sh/bash/python/..., `bash <(...)`,
#     `sh -c "$(...)"`), or
#   - is curl without --proto '=https' AND --proto-redir '=https' (the URL does not
#     have to be a literal: a variable is checked too), or
#   - turns certificate checking off (curl -k / --insecure, wget --no-check-certificate), or
#   - writes no file (-o / -O / --output), so there is nothing to verify, or
#   - is not followed, in the same command or within three lines, by `sha256sum -c` naming that
#     file outside a comment, or that `sha256sum -c` is allowed to fail (`|| true`).
# It also fails if nothing was scanned, so a moved directory or a mistyped
# CI_WORKFLOWS_UNDER_TEST cannot turn into a green result. The script then proves the checker
# itself: a set of good and bad fixtures must pass and fail as expected, so a weakened regex
# fails here instead of silently letting a download through.

cd "$(dirname "$0")/.."

workflows="${CI_WORKFLOWS_UNDER_TEST:-.github/workflows}"
dockerroot="${CI_DOCKERFILES_UNDER_TEST:-.}"

checker="$(cat <<'PY'
import re
import sys
from pathlib import Path

workflow_dir = Path(sys.argv[1])
docker_root = Path(sys.argv[2])
files = sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")])
skip = {"node_modules", ".git"}
dockerfiles = sorted(p for p in docker_root.rglob("Dockerfile*") if p.is_file() and not (skip & set(p.parts)))
if not files and not dockerfiles:
    print(f"no workflow files or Dockerfiles found under {workflow_dir} / {docker_root}: refusing to report a pass for nothing",
          file=sys.stderr)
    sys.exit(1)
if sys.argv[3:] != ["allow-no-workflows"] and not files:
    print(f"no workflow files found under {workflow_dir}: refusing to report a pass for nothing", file=sys.stderr)
    sys.exit(1)

# curl/wget at a COMMAND position (start of a line, or after && || ; | ( $( ` ! run: RUN sudo env then do else),
# optionally written with a path (/usr/bin/curl). `apt-get install curl` and https://host/curl/x are
# arguments, not commands.
PREFIX = r"(?:^|&&|\|\||;|\||\(|`|\$\(|!|\brun:|\bRUN\b|\bsudo\b|\benv\b|\bthen\b|\bdo\b|\belse\b)\s*"
TOOL = re.compile(PREFIX + r"(?:[\w.\-/]*/)?(curl|wget)(?=\s|$)")
SHELLISH = r"(?:sudo\s+)?(?:\S*/)?(?:ba|z|da|k|c)?sh|python[0-9.]*|perl|ruby|node"
problems = []
downloads = 0


def strip_comment(text):
    return re.sub(r"\s#.*$", "", text)


def check_file(path):
    global downloads
    raw = path.read_text(encoding="utf-8").splitlines()
    logical = []  # join backslash continuations, remembering the first physical line number
    index = 0
    while index < len(raw):
        start = index + 1
        text = raw[index]
        while text.rstrip().endswith("\\") and index + 1 < len(raw):
            index += 1
            text = text.rstrip()[:-1] + " " + raw[index].strip()
        logical.append((start, text))
        index += 1

    for position, (first, text) in enumerate(logical):
        if text.strip().startswith("#"):
            continue
        code = strip_comment(text)
        # a Dockerfile RUN is one logical line holding several downloads: check each one
        for match in TOOL.finditer(code):
            tool = match.group(1)
            rest = code[match.start(1):]
            stripped = text.strip()
            # an `echo`/`printf` that merely mentions the tool is not a download
            if re.match(r"^\s*(?:-\s+)?(?:run:\s+)?(?:echo|printf)\b", code):
                continue
            downloads += 1
            where = f"{path}:{first}"

            if re.search(rf"\|\s*(?:{SHELLISH})\b", rest) or re.search(rf"(?:{SHELLISH})\s+(?:-\w+\s+)*<\(", code) \
                    or re.search(rf"(?:{SHELLISH})\s+-c\s+[\"']?\$\(\s*(?:\S*/)?{tool}", code):
                problems.append(f"{where}: a download feeds a shell or interpreter: {stripped[:100]}")

            command = re.split(r"\s&&\s|;|\|\|", rest, maxsplit=1)[0]
            if tool == "curl":
                if "--proto '=https'" not in command or "--proto-redir '=https'" not in command:
                    problems.append(f"{where}: curl without --proto '=https' and --proto-redir '=https'")
                if re.search(r"(?:^|\s)(?:-[A-Za-z]*k[A-Za-z]*|--insecure)(?=\s|$)", command):
                    problems.append(f"{where}: curl with certificate checking turned off")
            elif re.search(r"--no-check-certificate", command):
                problems.append(f"{where}: wget with certificate checking turned off")

            out = re.search(r"(?:^|\s)(?:-o|-O|--output)[\s=]+(\S+)", command) \
                or re.search(r"(?:^|\s)-[A-Za-z]*[oO]\s+(\S+)", command)
            if not out:
                problems.append(f"{where}: {tool} writes no file (-o/-O/--output), so nothing can be checksum-verified")
                continue
            target = out.group(1).strip("\"'")
            # what comes AFTER the download command (the download's own `-o target` must not count as a mention)
            window = " ".join([rest[len(command):], *[strip_comment(t) for _, t in logical[position + 1:position + 4]]])
            checks = list(re.finditer(r"sha256sum\s+-c\b", window))
            named = re.search(r"(?<![\w.\-/])" + re.escape(target) + r"(?![\w.\-])", window)
            if not checks or not named:
                problems.append(f"{where}: {target} is not verified by `sha256sum -c` right after the download")
                continue
            for check in checks:
                tail = re.split(r"&&|;", window[check.start():], maxsplit=1)[0]
                if "||" in tail:
                    problems.append(f"{where}: the `sha256sum -c` for {target} is allowed to fail (`||`)")


for path in files:
    check_file(path)
for path in dockerfiles:
    check_file(path)

if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"{downloads} download command(s) in {len(files)} workflow file(s) and {len(dockerfiles)} Dockerfile(s) checked",
      file=sys.stderr)
PY
)"

echo "== the repository"
python3 -c "$checker" "$workflows" "$dockerroot"

# ---- the checker itself ---------------------------------------------------------------------------
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case_n=0
run_case() { # name, expectation (pass|fail), expected message fragment, kind (wf|df), content
  local name="$1" expect="$2" fragment="$3" kind="$4" content="$5" dir out status=0
  case_n=$((case_n + 1))
  dir="$work/case$case_n"
  mkdir -p "$dir/wf" "$dir/docker"
  if [ "$kind" = df ]; then printf '%s\n' "$content" >"$dir/docker/Dockerfile"; else printf '%s\n' "$content" >"$dir/wf/ci.yml"; fi
  out="$(python3 -c "$checker" "$dir/wf" "$dir/docker" allow-no-workflows 2>&1)" || status=$?
  if [ "$expect" = pass ]; then
    [ "$status" = 0 ] || { echo "FAIL: '$name' should pass but was rejected: $out" >&2; exit 1; }
  else
    [ "$status" != 0 ] || { echo "FAIL: '$name' should be rejected but passed" >&2; exit 1; }
    case "$out" in *"$fragment"*) ;; *) echo "FAIL: '$name' was rejected for the wrong reason (wanted '$fragment'): $out" >&2; exit 1 ;; esac
  fi
  echo "ok: $name"
}

GOOD_WF=$'jobs:\n  j:\n    steps:\n      - run: |\n          curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/x.tgz -o x.tgz\n          echo "abc  x.tgz" | sha256sum -c -'
run_case "a pinned, verified workflow download passes" pass "" wf "$GOOD_WF"
run_case "piped installer" fail "feeds a shell" wf $'      - run: curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/i.sh | sh'
run_case "absolute-path curl without hardening" fail "--proto" wf $'      - run: /usr/bin/curl -fsSL https://h/x -o x'
run_case "absolute-path curl piped to a shell" fail "feeds a shell" wf $'      - run: /usr/bin/curl --proto \'=https\' --proto-redir \'=https\' https://h/i.sh | bash'
run_case "missing --proto-redir" fail "--proto" wf $'      - run: |\n          curl -fsSL --proto \'=https\' https://h/x -o x\n          echo "abc  x" | sha256sum -c -'
run_case "certificate checking off" fail "certificate checking" wf $'      - run: |\n          curl -fsSLk --proto \'=https\' --proto-redir \'=https\' https://h/x -o x\n          echo "abc  x" | sha256sum -c -'
run_case "wget piped to a shell" fail "feeds a shell" wf $'      - run: wget -qO- https://h/i.sh | sh'
run_case "bash -c of a curl" fail "feeds a shell" wf $'      - run: bash -c "$(curl -fsSL https://h/i.sh)"'
run_case "no output file" fail "writes no file" wf $'      - run: curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/x'
run_case "no checksum" fail "not verified" wf $'      - run: curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/x -o x'
run_case "checksum allowed to fail" fail "allowed to fail" wf $'      - run: |\n          curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/x -o x\n          echo "abc  x" | sha256sum -c - || true'
run_case "file name only in a trailing comment" fail "not verified" wf $'      - run: |\n          curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/payload.bin -o payload.bin\n          sha256sum -c sums.txt # payload.bin'
run_case "checksum for a different file" fail "not verified" wf $'      - run: |\n          curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/payload.bin -o payload.bin\n          echo "abc  other.bin" | sha256sum -c -'
run_case "a URL containing /curl/ is not a command" pass "" wf $'      - run: echo see https://github.com/curl/curl/releases'
run_case "echo mentioning curl is not a download" pass "" wf $'      - run: echo "install curl first"'

GOOD_DF=$'RUN curl -fsSL --proto \'=https\' --proto-redir \'=https\' "https://h/d.tgz" -o /opt/d.tgz \\\n    && echo "abc  /opt/d.tgz" | sha256sum -c - \\\n    && tar -xzf /opt/d.tgz'
run_case "a pinned, verified Dockerfile download passes" pass "" df "$GOOD_DF"
run_case "Dockerfile download without a checksum" fail "not verified" df $'RUN curl -fsSL --proto \'=https\' --proto-redir \'=https\' "https://h/d.tgz" -o /opt/d.tgz && tar -xzf /opt/d.tgz'
run_case "Dockerfile download without --proto" fail "--proto" df $'RUN curl -fsSL "https://h/d.tgz" -o /opt/d.tgz \\\n    && echo "abc  /opt/d.tgz" | sha256sum -c -'
run_case "Dockerfile: second download unverified" fail "not verified" df $'RUN curl -fsSL --proto \'=https\' --proto-redir \'=https\' "https://h/a" -o /opt/a \\\n    && echo "abc  /opt/a" | sha256sum -c - \\\n    && curl -fsSL --proto \'=https\' --proto-redir \'=https\' "https://h/b" -o /opt/b \\\n    && chmod +x /opt/b'
run_case "Dockerfile piped installer" fail "feeds a shell" df $'RUN curl -fsSL --proto \'=https\' --proto-redir \'=https\' https://h/i.sh | sh'

echo "PASS: every CI and Dockerfile download is https-only, redirect-restricted and checksum-verified; nothing is piped into a shell; the checker rejects its ${case_n} fixtures as expected"
