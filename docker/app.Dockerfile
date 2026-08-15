# syntax=docker/dockerfile:1.7

# KODE Printer — application image.
#
# The converters live *in this image* rather than a sidecar, but they are
# executed through a sandbox wrapper as an unprivileged user with no network
# access (ADR-010). A sidecar was considered and rejected: it needs the upload
# volume shared read-write between two containers, which is a wider blast radius
# than a `bwrap` jail inside one.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /build

# argon2 compiles a native addon; without these the install fails with a message
# that sends people looking in entirely the wrong place.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/fake-printer/package.json tools/fake-printer/

RUN npm ci --ignore-scripts=false

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY tools/ tools/

RUN npm run build -w @kode/shared \
 && npm run build -w @kode/server \
 && npm --prefix apps/web run build

# Reinstall production-only, so devDependencies never reach the final image.
RUN npm ci --omit=dev --ignore-scripts=false

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# BIND_HOST and DEPLOYMENT_TOPOLOGY move together and must not be set apart.
# In a container the TLS terminator is a separate service, so the app has to
# bind a routable address to be reachable at all; the isolation §B18.3 requires
# comes from not publishing the port rather than from binding loopback. The boot
# guard checks the property that still applies here: that a trusted proxy is
# declared in front of it.
ENV NODE_ENV=production \
    KODE_DEBUG=false \
    DEPLOYMENT_TOPOLOGY=container \
    BIND_HOST=0.0.0.0 \
    PORT=3000

# LibreOffice and Ghostscript are OS binaries, not npm packages. §B10.6 makes
# their absence a boot failure in production, so they are installed here rather
# than left to a host that "probably has them".
#
# bubblewrap is the sandbox ADR-010 asks for: an unprivileged namespace jail
# with no network and a read-only filesystem outside the per-job temp directory.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      ghostscript \
      fonts-liberation fonts-dejavu-core \
      bubblewrap \
      tini \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# The application runs as a non-root user that owns nothing it does not need.
RUN groupadd --gid 10001 kode \
 && useradd --uid 10001 --gid kode --create-home --shell /usr/sbin/nologin kode

WORKDIR /app

COPY --from=build --chown=kode:kode /build/node_modules ./node_modules
COPY --from=build --chown=kode:kode /build/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=kode:kode /build/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=kode:kode /build/apps/server/dist ./dist
COPY --from=build --chown=kode:kode /build/apps/server/public ./public
COPY --from=build --chown=kode:kode /build/apps/server/package.json ./

RUN mkdir -p /data/uploads /data/scans /data/templates /data/tmp \
 && chown -R kode:kode /data

USER kode

# `--dev /dev` is needed because Ghostscript opens /dev/null; everything else is
# denied. `--unshare-net` is the control that matters most: a compromised
# converter cannot reach the database, the printers, or the internet. It is
# implied by `--unshare-all` and stated anyway, because a security control that
# depends on an aggregate flag's contents is one upstream change from silently
# not applying.
ENV CONVERT_SANDBOX_CMD="bwrap --unshare-all --unshare-net --die-with-parent --ro-bind / / --dev /dev --bind /data/tmp /data/tmp --proc /proc"

EXPOSE 3000

# §B13.3 — /health answers "is the process alive", which is exactly the question
# a container healthcheck should ask. /health/ready is for monitoring and would
# restart the container over a transient database blip.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# tini reaps the zombie processes LibreOffice leaves behind. Without it a busy
# day accumulates defunct `soffice.bin` entries until the PID table fills.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
