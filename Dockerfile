# Kaigara as one image: the orchestrator, the k6 engine binary, and the built UI served from the
# same origin. One container, one port, no proxy and no CORS — the frontend addresses the API with
# relative `/api/...` paths, so serving both from this process is the configuration.
#
#   docker run --rm -p 5174:5174 ghcr.io/<owner>/kaigara   the published image, on http://localhost:5174
#   docker compose up --build                             built from this checkout instead
#   docker build -t kaigara .                             just the image
#
# The published image is this file, built for linux/amd64 and linux/arm64 and pushed to the GitHub
# Container Registry by .github/workflows/docker-image.yml; README.md, "Running Kaigara", has the
# details.
#
# This is the *deployment* image. Day-to-day development is `npm run dev` (three processes, hot
# reload) or the Dev Container in .devcontainer/ — neither of which this replaces.
#
# No `# syntax=` directive on purpose: it makes BuildKit fetch its frontend image from the registry
# before it will even read this file, which is a network round trip (and a hang, behind a proxy that
# does not allow it) bought for features nothing here uses.

# Pinned rather than floating, for the same reason .devcontainer/Dockerfile pins them: the engine
# version is part of a benchmark result, so two people running the same image should be measuring
# with the same k6. Bump deliberately, and note the bump — numbers taken with different engine
# versions are not directly comparable.
ARG K6_VERSION=2.1.0
ARG NODE_VERSION=24

FROM grafana/k6:${K6_VERSION} AS k6

# ---------------------------------------------------------------------------------------------
# Build: the frontend's static bundle. Needs the full dependency tree (Vite, TypeScript) and, less
# obviously, the backend sources too — `frontend/vite.config.ts` imports the connection probe and
# the scenario library from `backend/src` so the dev server can mount the very same modules.
#
# Pinned to the *build* platform: the bundle is static files, identical for every target, so a
# multi-platform build compiles it once, natively, instead of once per platform under emulation.
# ---------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes, so editing source
# does not re-run the install.
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY packages/shared-types/package.json packages/shared-types/
RUN npm ci

COPY packages/shared-types/ packages/shared-types/
COPY backend/ backend/
COPY frontend/ frontend/
RUN npm run build -w frontend

# ---------------------------------------------------------------------------------------------
# Runtime: Node, the k6 binary, the backend sources, and the bundle built above. No compiler, no
# dev dependencies — the backend runs its TypeScript through Node's own type stripping, so there
# is nothing to build here and nothing but production dependencies to install.
# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim

# ca-certificates is what lets the connection probe and k6 speak TLS to an https AAS server; tini
# is PID 1, see ENTRYPOINT below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# k6 ships as a single static binary, so the engine is one file lifted out of its official image —
# no third-party apt repository and no signing key to manage. It is spawned as a subprocess and
# never linked in-process, which is what keeps its AGPL licence off this project's code
# (docs/adr/0001-pluggable-engine-adapter.md).
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY packages/shared-types/package.json packages/shared-types/
# Only the backend workspace and its dependencies: ~60 packages instead of the full tree, and no
# React or Vite in a runtime image that serves them as static files.
RUN npm ci --omit=dev --workspace @kaigara/backend --include-workspace-root \
 && npm cache clean --force

COPY packages/shared-types/ packages/shared-types/
COPY backend/ backend/
COPY --from=build /app/frontend/dist frontend/dist

# The run archive (backend/src/engines/k6/runArchive.ts): every generated script, plan and exact
# `k6 run` command line, kept so a benchmark can be reproduced by hand later. Its default,
# <cwd>/k6-logs, would land in the root-owned /app — and since the archive swallows its own write
# errors rather than fail a benchmark, it would silently never appear. Mount a volume here to keep
# it beyond the container's life.
RUN mkdir k6-logs && chown node:node k6-logs

# The scenario library needs no variable: it defaults to the backend/scenarios/ baked in above.
# Set KAIGARA_SCENARIOS_DIR to a mounted folder to offer different ones.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174 \
    KAIGARA_UI_DIR=/app/frontend/dist \
    KAIGARA_LOG_DIR=/app/k6-logs

EXPOSE 5174

# Unprivileged. The process writes to exactly two places: the OS temp directory (each run gets a
# work directory under `$TMPDIR/kaigara-runs` for its script and k6 summary) and the archive above,
# both of which `node` owns.
USER node

# Node's own fetch rather than curl, which a slim image does not carry.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# A real init as PID 1, so a plain `docker run` needs no `--init`. As PID 1 itself, Node would
# ignore `docker stop`'s SIGTERM (the orchestrator installs no handler) and be killed ten seconds
# later; tini forwards the signal and reaps any k6 process an aborted run orphans. `-s` keeps it
# correct, and quiet, when someone passes `--init` anyway and tini ends up PID 2.
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "backend/src/server.ts"]
