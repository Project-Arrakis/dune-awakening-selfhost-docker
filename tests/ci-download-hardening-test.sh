#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1158: a required CI job
# (trivy-image-scan) installed trivy by piping install.sh from the mutable `main`
# branch into `sh`, with no checksum on what it then downloaded. Every other tool
# install in .github/workflows/ci.yml pins a release URL and verifies a sha256.
#
# For EVERY curl or wget command in EVERY workflow file (.yml and .yaml; backslash
# continuations are joined first) this fails when the command:
#   - feeds a shell or interpreter (a pipe into sh/bash/python/..., `bash <(...)`,
#     `sh -c "$(...)"`), or
#   - is curl without --proto '=https' AND --proto-redir '=https' (the URL does not
#     have to be a literal: a variable is checked too), or
#   - writes no file (-o / -O / --output), so there is nothing to verify, or
#   - is not followed, within three lines, by `sha256sum -c` naming that file.
# It also fails if no workflow file was scanned at all, so a moved directory or a
# mistyped CI_WORKFLOWS_UNDER_TEST cannot turn into a green result.

cd "$(dirname "$0")/.."

workflows="${CI_WORKFLOWS_UNDER_TEST:-.github/workflows}"

python3 - "$workflows" <<'PY'
import re
import sys
from pathlib import Path

directory = Path(sys.argv[1])
files = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])
if not files:
    print(f"no workflow files found under {directory}: refusing to report a pass for nothing", file=sys.stderr)
    sys.exit(1)

TOOL = re.compile(r"(?<![\w./-])(curl|wget)\b")
SHELLISH = r"(?:sudo\s+)?(?:\S*/)?(?:ba|z|da|k|c)?sh|python[0-9.]*|perl|ruby|node"
problems = []
downloads = 0

for path in files:
    raw = path.read_text(encoding="utf-8").splitlines()
    # join backslash continuations, remembering the first physical line number
    logical = []
    index = 0
    while index < len(raw):
        start = index + 1
        text = raw[index]
        while text.rstrip().endswith("\\") and index + 1 < len(raw):
            index += 1
            text = text.rstrip()[:-1] + " " + raw[index].strip()
        logical.append((start, index + 1, text))
        index += 1

    for position, (first, last, text) in enumerate(logical):
        stripped = text.strip()
        if stripped.startswith("#"):
            continue
        code = re.sub(r"\s#.*$", "", text)
        if not TOOL.search(code):
            continue
        # an `echo`/`printf` that merely mentions the tool is not a download
        if re.match(r"^\s*(?:-\s+)?(?:run:\s+)?(?:echo|printf)\b", code):
            continue
        downloads += 1
        where = f"{path}:{first}"
        tool = TOOL.search(code).group(1)

        if re.search(rf"\|\s*(?:{SHELLISH})\b", code) or re.search(rf"(?:{SHELLISH})\s+(?:-\w+\s+)*<\(", code) \
                or re.search(rf"(?:{SHELLISH})\s+-c\s+[\"']?\$\(\s*{tool}", code):
            problems.append(f"{where}: a download feeds a shell or interpreter: {stripped[:100]}")

        if tool == "curl" and ("--proto '=https'" not in code or "--proto-redir '=https'" not in code):
            problems.append(f"{where}: curl without --proto '=https' and --proto-redir '=https'")

        out = re.search(r"(?:^|\s)(?:-o|-O|--output)[\s=]+(\S+)", code)
        if not out:
            problems.append(f"{where}: {tool} writes no file (-o/-O/--output), so nothing can be checksum-verified")
            continue
        target = out.group(1).strip("\"'")
        window = " ".join(t for _, _, t in logical[position + 1 : position + 4])
        if not re.search(r"sha256sum\s+-c", window) or target not in window:
            problems.append(f"{where}: {target} is not verified by `sha256sum -c` right after the download")

if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"{downloads} download command(s) in {len(files)} workflow file(s) checked", file=sys.stderr)
PY

echo "PASS: every CI download is https-only, redirect-restricted and checksum-verified; nothing is piped into a shell"
