FROM node:25-trixie-slim AS web-build
WORKDIR /app/web
COPY console/web/package.json ./
COPY console/web/package-lock.json ./
RUN npm ci
COPY runtime/data/augment-compatibility.json /runtime/data/augment-compatibility.json
COPY console/web ./
RUN npm run build

FROM node:25-trixie-slim
LABEL io.github.red-blink.dune-selfhost.component="console"
WORKDIR /app
ENV NODE_ENV=production

# Runtime tools required by RedBlink dune scripts when the web admin runs in a container.
# We install small OS tools through apt, then install Docker CLI + Compose plugin
# as standalone binaries to avoid pulling the heavy docker.io Debian package.
# gnupg (gpg) is required by `dune db backup-system`'s authenticated
# (AEAD/OCB) archive encryption when the backup is triggered from the
# Web Console rather than a host shell -- confirmed this was NOT already
# present in this image, which would make that command fail here even
# though it worked on a real host with gnupg installed via install.sh.
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
RUN apt-get update \
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
    && curl -fsSL "https://github.com/docker/compose/releases/download/v5.5.0/docker-compose-linux-${compose_arch}" \
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
ENV HOME=/tmp/dune-console-home
ENV DOCKER_CONFIG=/tmp/dune-console-home/.docker
USER dune
WORKDIR /repo
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/src/server.js"]
