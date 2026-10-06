FROM node:24-trixie-slim AS web-build
WORKDIR /app/web
COPY console/web/package.json ./
COPY console/web/package-lock.json ./
RUN npm ci
COPY runtime/data/augment-compatibility.json /runtime/data/augment-compatibility.json
COPY runtime/data/admin-skill-modules.json /runtime/data/admin-skill-modules.json
COPY console/web ./
RUN npm run build

FROM node:24-trixie-slim
LABEL io.github.red-blink.dune-selfhost.component="console"
WORKDIR /app
ENV NODE_ENV=production

# Runtime tools required by RedBlink dune scripts when the web admin runs in a container.
# We install small OS tools through apt, then install Docker CLI + Compose plugin
# as standalone binaries to avoid pulling the heavy docker.io Debian package.
# The psql client is what decides how the console's publisher loops reach the
# database. runtime/scripts/lib/postgres.sh and runtime/scripts/dune_psql.py
# prefer a TCP connection to the port start-postgres.sh publishes on loopback
# and fall back to `docker exec dune-postgres psql` when no client is installed
# -- and this image had none, so every query from here took the fallback.
# publish-deepdesert-overrides.sh alone re-queries every ten seconds and fans
# out over every partition, and each exec spawns a conmon pair that lingers for
# the engine's exit delay. The container runs with network_mode: host (see
# docker-compose.web.yml), so 127.0.0.1 here really is the host's loopback and
# really does reach the published port.
# gnupg (gpg) is required by `dune db backup-system`'s authenticated
# (AEAD/OCB) archive encryption when the backup is triggered from the
# Web Console rather than a host shell. The VERSION is what matters, not
# just the package: --aead-algo landed in GnuPG 2.3, and bookworm caps at
# 2.2.40, which rejects the flag outright -- so this image could install
# gnupg and still fail every system backup, after dumping the whole
# database. bookworm-backports carries the same 2.2.40, so the base is
# trixie (Debian 13), whose gnupg 2.4.7 supports it. db.sh preflights the
# capability and refuses to downgrade to an unauthenticated cipher, so an
# older base fails loudly rather than silently weakening the archive.
#
# python3 must be installed EXPLICITLY, not inherited. It used to arrive for
# free: the previous base was node:20-bookworm, whose full Debian image ships
# python3-minimal. Commit c248780e (2026-08-20, issue #54's Trivy-driven base
# bump) swapped that for node:24-trixie-slim, which does not -- silently
# removing an interpreter this image genuinely needs, with no build-time or CI
# failure to show for it (issue #489).
#
# It is needed because the console does NOT shell out to the host: runner.js
# spawns `dune` locally (plain spawn, cwd=/repo), so runtime-env.sh's python3
# calls and runner.js's own `usersettings` python3 spawn all execute in THIS
# image. Without it `dune status` exits 127 with empty stdout and the Home
# panel shows only "Server status is unavailable".
#
# Everything under runtime/scripts/*.py is pure stdlib, so the bare interpreter
# is enough -- no python3-yaml, no pip packages.
#
# libpcre2-8-0 is targeted for an explicit --only-upgrade (2026-09-15,
# issue #934's trivy-image-scan run, CVE-2026-86145/CVE-2026-89161): it's a
# base-image package we never install ourselves, so `apt-get update` alone
# refreshes the index but does not pull the newer, already-fixed
# 10.46-1~deb13u2 that a fresh index makes available -- a real version bump
# per .trivyignore's own policy, not a suppression, so it's applied here
# rather than added to that file. Deliberately NOT a blanket `apt-get
# upgrade` (hadolint DL3005, and see .hadolint.yaml's own note on why
# OS-package freshness is handled via targeted fixes/base-image bumps, not
# a full-system upgrade every build).
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade \
        libpcre2-8-0 \
    && apt-get install -y --no-install-recommends \
        iproute2 \
        ca-certificates \
        curl \
        bash \
        unzip \
        procps \
        netcat-openbsd \
        gnupg \
        python3 \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) docker_arch="x86_64"; compose_arch="x86_64" ;; \
        arm64) docker_arch="aarch64"; compose_arch="aarch64" ;; \
        *) echo "Unsupported architecture for Docker CLI: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-29.7.2.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-${compose_arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && docker --version \
    && docker compose version

COPY console/api/package.json ./
COPY console/api/package-lock.json ./
RUN npm ci --omit=dev
COPY console/api/src ./src
COPY --from=web-build /app/web/dist /app/web-dist
COPY console/api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && useradd -m -s /bin/bash dune \
    && mkdir -p /repo /app \
    && chmod 755 /app /repo
# The runtime image only ever runs `node /app/src/server.js`; npm/npx are build-time
# tools. Their bundled packages (brace-expansion, undici, ...) are scanned by
# trivy-image-scan and re-flag every time the Node base image lags an advisory.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV HOME=/tmp/dune-console-home
ENV DOCKER_CONFIG=/tmp/dune-console-home/.docker
USER dune
WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/src/server.js"]
