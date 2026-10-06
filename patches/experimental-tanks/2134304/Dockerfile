ARG BASE_IMAGE=redblink-dune-tank-base:2134304-cc1980f62640
FROM ${BASE_IMAGE}
COPY --chown=dune:nogroup DuneSandboxServer-Linux-Shipping /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
COPY --chown=dune:nogroup assets/ /home/dune/server/DuneSandbox/Content/Paks/
RUN chmod 755 /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
LABEL io.github.red-blink.dune-selfhost.component="experimental-tanks" io.github.red-blink.dune-selfhost.tank-build="2134304-0-shipping"
