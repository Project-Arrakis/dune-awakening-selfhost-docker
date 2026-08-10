ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY --chown=dune:dune DuneSandboxServer-Linux-Shipping \
  /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
RUN chmod 0755 /home/dune/server/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping
