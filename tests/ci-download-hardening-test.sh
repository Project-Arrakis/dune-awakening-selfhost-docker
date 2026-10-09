#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for dune-awakening-selfhost-docker#1158: a required CI job
# (trivy-image-scan) installed trivy by piping install.sh from the mutable `main`
# branch into `sh`, with no checksum on what it then downloaded. Every other tool
# install in .github/workflows/ci.yml pins a release URL and verifies a sha256.
#
# This fails when a workflow (a) pipes a download into a shell, or (b) fetches a
# release artifact with curl without --proto '=https' AND --proto-redir '=https'
# AND a following `sha256sum -c` on the file it wrote.

cd "$(dirname "$0")/.."

workflows="${CI_WORKFLOWS_UNDER_TEST:-.github/workflows}"

python3 - "$workflows" <<'PY'
import re
import sys
from pathlib import Path

problems = []
for path in sorted(Path(sys.argv[1]).glob("*.yml")):
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, line in enumerate(lines, 1):
        code = line.split("#", 1)[0] if line.lstrip().startswith("#") else line
        if re.search(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b", code):
            problems.append(f"{path}:{number}: downloads are piped into a shell: {line.strip()[:110]}")
        if re.search(r"\bcurl\b", code) and "http" in code and not line.lstrip().startswith("#"):
            if "--proto '=https'" not in code or "--proto-redir '=https'" not in code:
                problems.append(f"{path}:{number}: curl without --proto '=https' and --proto-redir '=https'")
            out = re.search(r"-o\s+(\S+)", code)
            if not out:
                problems.append(f"{path}:{number}: curl without -o, so nothing can be checksum-verified")
                continue
            target = out.group(1)
            following = "\n".join(lines[number : number + 3])
            if not re.search(r"sha256sum\s+-c", following) or target not in following:
                problems.append(f"{path}:{number}: {target} is not verified by `sha256sum -c` right after the download")

if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
PY

echo "PASS: every CI download is https-only, redirect-restricted and checksum-verified; nothing is piped into a shell"
