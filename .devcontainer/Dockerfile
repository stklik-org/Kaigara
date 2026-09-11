# Kaigara's development image.
#
# Deliberately thin. It is the official Node image ("slim": Debian with no compiler toolchain, no
# docs, no man pages) plus exactly two additions:
#
#   - git, because the editor's source control and the everyday workflow need it, and
#   - the k6 binary, because running a benchmark spawns `k6` as an external subprocess
#     (docs/adr/0001-pluggable-engine-adapter.md — k6 is never linked in-process, which is also
#     what keeps its AGPL licence off this project's code).
#
# Nothing else is baked in. The workspace is a bind mount and its dependencies are installed by
# `postCreateCommand` in devcontainer.json, so the image stays independent of the lockfile and
# does not need rebuilding when a dependency changes.

# Pinned rather than floating: the engine version is part of a benchmark result, so two people on
# the same commit should be measuring with the same k6. Bump it deliberately, and note the bump —
# numbers taken with different engine versions are not directly comparable.
ARG K6_VERSION=2.1.0
# Node 24 is the active LTS line, and matches the `@types/node` major the workspaces depend on.
# Anything >= 22.18 works: the backend and the tests run `.ts` files through Node's own type
# stripping, with no build step (see backend/README.md).
ARG NODE_VERSION=24

FROM grafana/k6:${K6_VERSION} AS k6

FROM node:${NODE_VERSION}-bookworm-slim

# --no-install-recommends is what keeps this to git itself rather than git plus a suggested tree of
# perl docs and editors. ca-certificates is what lets npm and the connection probe speak TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
 && rm -rf /var/lib/apt/lists/*

# k6 ships as a single static binary, so the engine is one file lifted out of its official image —
# no third-party apt repository, no signing key to manage, nothing left over from the install.
# `KAIGARA_K6_BINARY` still overrides the path if you want a different build
# (backend/src/engines/k6/k6Adapter.ts).
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6

# The Node image already provides an unprivileged `node` user (uid 1000); the container runs as it
# rather than as root, so files it writes into the bind-mounted workspace are yours.
USER node
