# CI Security Tooling

Every security scanner this repo runs, what it catches, where it runs (local pre-commit vs. CI), and why it exists. Added 2026-08-20 alongside four new CI gates (`govulncheck`, `hadolint`, `osv-scanner`, `trivy-image-scan`) that closed real, previously-undetected gaps -- see "What Each Gate Has Actually Caught" below for the concrete findings that justified each one, not just the theoretical case for it.

## The Full Tool Inventory

| Tool | Catches | Runs |
|---|---|---|
| `gitleaks` | Secrets in git history/diffs | Local pre-commit + `security-checks` CI job |
| `ggshield` | Secrets (GitGuardian's detector, different signature set than gitleaks) | Local pre-commit |
| `trivy` (secret scanner) | Secrets in the working tree | Local pre-commit + `security-checks` CI job |
| `semgrep` | SAST -- injection, ReDoS, insecure defaults, framework-specific patterns | Local pre-commit (`p/default`, fast) + `semgrep.yml` CI job (`semgrep ci`, full Pro ruleset, requires `SEMGREP_APP_TOKEN`) |
| `shellcheck` | Shell script correctness/safety bugs | `security-pr-checks.sh` (changed `.sh` files only) |
| `npm audit` | Known-vulnerable npm dependencies (console/api, console/web) | `api-dependency-audit` CI job |
| CodeQL | SAST, GitHub-native, JS/TS | GitHub's own scheduled + push-triggered workflow |
| **`govulncheck`** | Call-graph-aware Go vulnerability detection (only flags CVEs your code actually reaches, not just "this version is listed") | **New: `govulncheck` CI job** |
| **`hadolint`** | Dockerfile correctness/hardening (unpinned base tags, missing `--no-install-recommends`, shell-form entrypoints, etc.) | **New: `hadolint` CI job** |
| **`osv-scanner`** | Broader multi-ecosystem SCA (npm + Go from one cross-ecosystem advisory database) as defense-in-depth alongside `npm audit`/`govulncheck` | **New: `osv-scanner` CI job** |
| **`trivy` (image scanner)** | CVEs in the built runtime image itself -- base OS packages, not just application dependencies | **New: `trivy-image-scan` CI job** (promotes issue #54 from a one-off manual check to a standing gate) |

Three different secret scanners (gitleaks, ggshield, trivy-secret) is intentional redundancy, not an oversight -- each has a different detection signature set and false-negative profile; running all three costs little and catches more than any one alone.

## Why Each New Gate, Specifically

**`govulncheck`** exists because `runtime/public-probe` (the only Go component in this repo) had **zero** Go-specific security tooling before this. `npm audit` only covers npm; `semgrep`'s `p/default`/CI rulesets are JS/TS/Python-focused and do not meaningfully cover Go. Nothing in CI would have ever caught a Go stdlib or dependency CVE.

**`hadolint`** exists because none of the three Dockerfiles in this repo (`orchestrator/Dockerfile`, `console/api/Dockerfile`, `runtime/public-probe/Dockerfile`) had ever been linted. `trivy image` (below) catches CVEs in what actually got installed; `hadolint` catches the *practices* that make a Dockerfile more likely to accumulate CVEs or behave unpredictably in the first place (floating base-image tags, unnecessary recommended packages, etc.) -- the two are complementary, not redundant.

**`osv-scanner`** exists as defense-in-depth: `npm audit` only queries npm's own advisory feed, and Go has no equivalent per-ecosystem `npm audit`-style command outside `govulncheck` (which is reachability-aware but only Go-scoped). OSV's database is broader and cross-ecosystem, so it can catch an advisory the narrower per-ecosystem tools miss, at the cost of not being reachability-aware (it flags "this version is listed," not "your code calls the vulnerable function").

**`trivy-image-scan`** exists because issue [#54](https://github.com/yacketrj/dune-awakening-selfhost-docker/issues/54) found real HIGH/CRITICAL findings in the built console runtime image via a one-off manual `trivy image` run (2026-06-22) that was never wired into CI -- meaning the exact same class of finding could silently reappear on the next base-image update with nothing to catch it. This gate builds the real `console/api/Dockerfile` image and scans it on every PR, closing that gap permanently rather than depending on someone remembering to re-run the manual command.

## What Each Gate Has Actually Caught (Real, Not Theoretical)

This section exists because a security gate justified only in the abstract ("more tooling is good") is exactly the kind of thing that gets silently disabled the first time it's inconvenient. Each gate below is backed by a real finding from the day it was added:

- **`govulncheck`** found **26 code-reachable Go standard-library CVEs** in `runtime/public-probe` on its first real run -- real call chains from `main.go`'s HTTP client, TLS handshake, x509 parsing, and ASN.1 decoding into vulnerable stdlib functions (`crypto/tls`, `crypto/x509`, `encoding/asn1`, `encoding/pem`, `net/url`, `net/textproto`). All 26 were toolchain-version-driven and fixed by bumping `go.mod`'s `go` directive and the Dockerfile's `golang:` build-stage tag to a patched point release (`1.25.13`) -- see the commit that added this gate for the exact before/after. One additional finding (`GO-2026-5932`, the unmaintained `golang.org/x/crypto/openpgp` sub-package, pulled in transitively by the pion WebRTC stack) has no available fix and is not reachable by any code path in this repo -- accepted, documented here rather than suppressed silently.
- **`hadolint`** found unpinned `apt-get`/`apk` package versions across all three Dockerfiles and a missing `--no-install-recommends` on `orchestrator/Dockerfile`'s `apt-get install` (which pulls in `docker.io` -- a package with substantial recommended-package weight). The missing flag was fixed directly; version-pinning was deliberately *not* applied project-wide -- see `.hadolint.yaml` for why (exact OS-package version pins go stale within weeks with nothing in this repo to keep them current, unlike the real application dependencies, which already have lockfiles + Dependabot).
- **`osv-scanner`** found 0 vulnerabilities on introduction (both npm projects and the Go module were already clean per the tools above) -- included anyway as a standing safety net, not because it found something today.
- **`trivy-image-scan`** — see issue #54 for its original findings; this gate's own CI run is the current, authoritative answer to "what does this scan find today," not this document (which will drift the moment a base image updates).

## Local Reproduction

Every gate above can be run locally exactly as CI runs it:

```bash
# govulncheck
cd runtime/public-probe && govulncheck ./...

# hadolint
hadolint --config .hadolint.yaml orchestrator/Dockerfile
hadolint --config .hadolint.yaml console/api/Dockerfile
hadolint --config .hadolint.yaml runtime/public-probe/Dockerfile

# osv-scanner
osv-scanner scan source --recursive .

# trivy image scan (requires a local Docker build first)
docker build -f console/api/Dockerfile -t redblink-dune-docker-console:ci .
trivy image --scanners vuln,secret --severity HIGH,CRITICAL --ignorefile .trivyignore redblink-dune-docker-console:ci
```

None of `govulncheck`/`hadolint`/`osv-scanner` are wired into the local `.pre-commit-config.yaml` fast tier (see Project-Arrakis's documented two-tier semgrep design for why that tier is deliberately narrow and fast) -- they run only in CI. An operator who wants them locally before pushing can add them to a personal pre-commit config without affecting this repo's shared one.
