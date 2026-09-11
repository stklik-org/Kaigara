# 貝殻 (Kaigara)

*A generic, standards-based benchmarking tool for Asset Administration Shell (AAS) servers.*

(kaigara — "seashell": a small nod to the Administration *Shell* the tool benchmarks.)

## Status

A prototype with a real spine: you can point it at an AAS server, compose a load
timeline, execute it through k6, and watch the results arrive. Everything *around*
that spine is still the shape it will grow into. Scope and structure are still
settling, so expect this document — and the layout around it — to change often.
Treat it as a snapshot, not a specification. The fuller rationale lives in the
project proposal and is deliberately not repeated here, so the two don't drift out
of sync.

**Real today.** Connecting to a target server, via a standards-only reachability and
conformance probe. A scenario library, which is a folder of documents on disk.
Composing a load timeline, in a visual track editor and in its JSON — two renderings
of one document, not an editor plus an export. And executing that timeline: it is
validated, compiled into a k6 execution plan (one k6 executor per load shape),
rendered into a k6 script, run as an external subprocess, and streamed back as
aggregated live metrics. The
backend's whole surface is browsable and executable at `/swagger`, so a benchmark can be
driven without the frontend at all.

**Not yet.** The preparation, precondition, postcondition and cleanup phases — only
the load method runs, and the other four report `skipped` rather than `done`, so a
clean run is never mistaken for "correctness checks passed". Nor: saving scenarios
back to the library, run history (runs are held in memory and do not survive a
restart), resource-usage correlation, or the Analyze screen, which is still mock data.

## What this is

A tool for benchmarking AAS server implementations against realistic, reusable
"recipes": declarative descriptions of a benchmark scenario covering data
preparation, correctness preconditions, the load itself, correctness
postconditions, and cleanup.

In the code and the UI these are called **scenarios** — one JSON document with those
five phases, of which only the load itself (`phases.method`) is modelled and executed
today. "Recipe" is the proposal's word for the same idea; the two are not different
things.

See [`metamodel.puml`](./metamodel.puml) (source) / [`metamodel.png`](./metamodel.png)
(rendered) for the class diagram of the current Scenario / Track / Load /
LoadShape / RequestComposition / RequestGenerator domain model (the "load itself"
part above), and [`architecture.puml`](./architecture.puml) /
[`architecture.png`](./architecture.png) for the system architecture (frontend,
backend orchestrator, engine adapters, target servers) — colour-coded by what's
actually implemented today versus still proposed.

Both are PlantUML; re-render them after an edit with `plantuml -tpng metamodel.puml`
and rename the output onto `metamodel.png` (the `@startuml <name>` line decides the
generated filename, which is not the one committed here).

## Running Kaigara

To use the tool rather than work on it you need Docker and nothing else. Every push to `main`
publishes a ready-made image to the GitHub Container Registry — the orchestrator, the k6 engine and
the built UI in one:

```bash
docker run --rm -p 5174:5174 ghcr.io/<owner>/kaigara:latest
```

Then open <http://localhost:5174>. `<owner>` is the GitHub user or organisation hosting this
repository, lower-cased. The API and its Swagger UI answer on the same port (`/api/...`,
`/swagger`), the demo scenarios are built in, and there is nothing to configure. Ctrl-C stops it.

The image exists for `linux/amd64` and `linux/arm64`, and Docker pulls the native one. That matters
more than usual here: an arm64 laptop running an amd64 image under emulation would be measuring its
emulation layer as much as the server under test.

### A server to point it at

A benchmark needs an AAS server on the other end. Enter it on the Connect screen as an address the
*container* can reach: a server on your own machine is `http://host.docker.internal:<port>/api/v3`
(on Linux, add `--add-host=host.docker.internal:host-gateway` to the `docker run`), never
`localhost`, which inside the container means the container itself.

With no server at hand, the same image carries the stub AAS server used in development:

```bash
docker network create kaigara
docker run -d --rm --name stub-aas --network kaigara -e PORT=8081 \
  ghcr.io/<owner>/kaigara:latest node backend/src/devtools/stubAasServer.ts
docker run --rm -p 5174:5174 --network kaigara ghcr.io/<owner>/kaigara:latest
```

and connect to `http://stub-aas:8081/api/v3`; afterwards, `docker stop stub-aas && docker network
rm kaigara`. From a checkout, `KAIGARA_IMAGE=ghcr.io/<owner>/kaigara:latest docker compose --profile
demo up` does all of that in one command. Either way the load generator and its target share one
machine's CPU, so the numbers mean nothing — it is for seeing the tool work, not for measuring.

### Keeping your own scenarios and runs

The container keeps nothing you do not mount:

| To… | add to `docker run` |
|---|---|
| offer your own scenario library instead of the bundled demos | `-v "$PWD/my-scenarios:/app/scenarios:ro" -e KAIGARA_SCENARIOS_DIR=/app/scenarios` |
| keep the run archive — every generated k6 script, plan and exact `k6 run` command line | `-v kaigara-k6-logs:/app/k6-logs` |
| serve on another port | `-p 8080:5174`, then open :8080 |

The archive goes in a named volume rather than a host folder because a volume takes its ownership
from the image, so the unprivileged user inside can write to it on every host;
`docker cp <container>:/app/k6-logs .` copies it out. Runs themselves are held in memory (see
[Status](#status)), so a restarted container starts with an empty run list.

### Which image

| Tag | is |
|---|---|
| `latest`, `main` | the tip of `main` |
| `sha-<commit>` | one exact commit (7-character hash) — the one to name next to results that must be reproducible |
| `1.2.3`, `1.2` | a `v1.2.3` release tag, once there are any |

`docker pull ghcr.io/<owner>/kaigara:latest` updates. The k6 version is pinned inside the image,
because it is part of every number the tool produces; `docker run --rm
ghcr.io/<owner>/kaigara:latest k6 version` says which one.

A refused pull (`denied` or `unauthorized`) means the package is private. Either log in first —
`docker login ghcr.io` with a GitHub personal access token (classic) carrying `read:packages` — or
have the owner make it public, see below.

### Building the image yourself

The same image builds from a checkout, which is the way to try a change before it is pushed:

```bash
docker compose up --build                  # the tool on http://localhost:5174
docker compose --profile demo up --build   # ... plus a stub AAS server on :8081 to point it at
docker compose down
```

One port, because the frontend addresses the API with relative `/api/...` paths: served by the
orchestrator itself (`KAIGARA_UI_DIR`), there is no proxy, no CORS and no build-time base URL to
configure. Swagger UI comes along at `/swagger` on the same port. `backend/scenarios/` is mounted
read-only, so a scenario can be added by dropping a file in rather than rebuilding, and the run
archive goes to a named volume that outlives `docker compose down`.

The stub is behind a profile deliberately. It exists so the tool has something to talk to out of
the box, but co-locating the target with the load generator means they compete for the same CPU —
fine for a walkthrough, worthless as a measurement. In this setup it answers the orchestrator at
`http://stub-aas:8081/api/v3`.

To check a build the way CI checks it before publishing:

```bash
docker build -t kaigara:local .
node scripts/smoke-test-image.mjs kaigara:local
```

It starts the image beside the stub, and fails unless the UI is served, the stub is reachable
through the connection probe, a real k6 run (`minimal-crud`) completes, its run archive is written,
and `docker stop` is honoured promptly. Everything it starts is removed again, and it binds a random
port, so it can run next to a development stack.

### How the image gets published

`.github/workflows/docker-image.yml` builds the root `Dockerfile` on every push to `main`, every
`v*` tag, every pull request, and on demand (*Actions → Docker image → Run workflow*). The image for
the runner's own platform is built first and has to pass the smoke test above; only then are both
platforms built and pushed, under the tags listed. Pull requests go through the same build and
smoke test but push nothing.

For GHCR there is nothing to set up — the workflow logs in with the repository's own
`GITHUB_TOKEN` — except one step after the very first publish: GHCR creates a new package as
**private**, whatever the repository's visibility. To let anyone pull without logging in, open the
package (the repository's *Packages* sidebar → `kaigara`) → *Package settings* → *Change
visibility* → *Public*. An organisation may have to allow public packages first.

To publish to a different registry — a self-hosted one, say — set the repository variable
`IMAGE_NAME` to the full image name, registry host included and tag left off
(`registry.example.org/aas/kaigara`), and the repository secrets `REGISTRY_USERNAME` and
`REGISTRY_PASSWORD`.

## Development environment

Development happens inside a [Dev Container](https://containers.dev): one Docker image
carrying everything the project needs. That removes the two setup steps a checkout used
to imply — a Node version new enough to run `.ts` files without a build step, and a k6
binary on `PATH` — and it pins the load-generation engine, which matters more than usual
here: k6's version is part of any number this tool produces.

### What you need on your machine

Docker (Docker Desktop, OrbStack, Rancher Desktop — anything speaking the Docker API), plus
either VS Code with the **Dev Containers** extension or the `devcontainer` CLI. Node, npm and
k6 all live in the container; you do not need them installed.

### Getting in

In VS Code, open the folder and accept **Reopen in Container** (or run *Dev Containers: Reopen
in Container* from the command palette). The first start builds the image and runs `npm install`
across the workspaces; later starts reuse both.

Without VS Code:

```bash
npm install -g @devcontainers/cli
devcontainer up --workspace-folder .        # uncomment "appPort" first, see below
devcontainer exec --workspace-folder . bash
```

### Running it

The commands are the same ones as before — they just run inside the container now:

```bash
npm run dev -w frontend        # Vite on :5173; Connect and Load work with nothing else running
```

The dev server mounts the connection probe and the scenario library in-process, so that one
command is enough to click around. **Running an actual benchmark needs the orchestrator too** —
which is what the root `dev` script is for:

```bash
npm run dev                    # orchestrator :5174 + stub AAS :8081 + frontend :5173, one terminal
npm run dev -- --no-stub       # the same without the stub, for aiming at a real server
```

One process per service, output prefixed and colour-coded, Ctrl-C stops all of them, and any one
of them dying stops the rest — two thirds of a stack running looks like it works right up until
the Run button. It refuses to start if a port is already taken, naming which, because the backend
runs under `node --watch` and would otherwise sit there alive after a failed `listen`.

Then Connect → activate a target → Compose → **Run**. The stub is there so there is something to
point at; use a real server whenever you have one. The whole API is browsable and executable at
**<http://127.0.0.1:5174/swagger>**, which is how to drive a benchmark without the frontend.

The individual commands still exist (`npm run dev:backend`, `npm run dev:frontend`,
`npm run stub-aas -w backend`) — the script is a convenience over them, not a replacement. Note
that the frontend needs `KAIGARA_BACKEND_URL=http://127.0.0.1:5174` when started on its own, or
the Run button posts into the Vite dev server and gets a 404.

#### Only ever one backend

A second orchestrator is easy to start and hard to notice: it runs under `node --watch`, which
keeps the supervisor alive after a failed `listen` and waits for a file to change — so it looks
like a running server, and requests keep going to the *first* copy. Three things now make that
loud instead of silent:

```bash
npm run stop     # stops whatever holds 5173, 5174 or 8081, naming each one
```

- `npm run dev` checks all three ports before starting anything, and names the process holding one.
- `npm run dev -w backend`, `npm start -w backend` and `npm run stub-aas -w backend` do the same
  through `pre*` hooks, so a single service started on its own refuses just as loudly.
- The server itself answers `EADDRINUSE` with a sentence rather than a stack trace.

If you want a second one deliberately, `PORT=5175 npm start -w backend` is the way — the check is
per port, not a global lock.

VS Code forwards 5173, 5174 and 8081 as they come up, so <http://localhost:5173> in your own
browser is the app. The `devcontainer` CLI has no forwarding agent: uncomment `appPort` in
`.devcontainer/devcontainer.json` to publish the ports the plain Docker way.

You do not need to do anything about host binding. The container sets `HOST=0.0.0.0` (a loopback
bind is right on a laptop and wrong in a container, where it makes a published port unreachable);
the two Node servers read that themselves, and `npm run dev` translates it into the `--host` flag
Vite needs, since Vite ignores the variable.

A target to point at: `npm run dev` starts the stub AAS server alongside, on 8081. To benchmark
something real from inside the container — the BaSyx stack in `basyx-setup-update/`, say, running
on your host — use `http://host.docker.internal:8081` as the base URL rather than `127.0.0.1`,
which inside a container means the container itself.

Checks:

```bash
npm test -w @kaigara/backend        # plan compiler, k6 output parser, scenario library, API docs
npm test -w @kaigara/shared-types   # timeline round-trip + validation
npm run lint -w frontend
npm run build -w frontend
npm run schema:check -w @kaigara/shared-types
```

### What is in the image — and what is deliberately not

`node:24-bookworm-slim` (the official Node image on Debian, without the compiler toolchain, docs
or man pages) plus exactly two additions: `git`, and the `k6` binary lifted out of the official
`grafana/k6` image. No Dev Container Features, no global npm packages, no language servers baked
in. That is ~400 MB, nearly all of it Node and k6 themselves.

k6 arrives as a single static binary copied between image stages, so there is no third-party apt
repository or signing key in the build, and nothing left over from installing it. It runs as an
external subprocess, never linked in-process, which is the boundary the engine-adapter decision
record draws for licensing reasons.

Both versions are pinned as build args in `.devcontainer/Dockerfile`: `K6_VERSION` because two
people on the same commit should be measuring with the same engine, and `NODE_VERSION` because
the backend and the tests lean on Node's own type stripping. Bumping k6 is a deliberate edit,
and worth saying out loud next to any results that straddle it.

This image is a development environment, not a deployment artefact. The deployment image is the
root `Dockerfile` — see [Running Kaigara](#running-kaigara).

### Things worth knowing

- **`node_modules` becomes a Linux `node_modules`.** It sits in the bind-mounted checkout, and
  several dependencies (rolldown, oxlint, Tailwind's oxide) ship per-platform binaries. Installing
  in the container replaces the macOS ones, so if you go back to running natively, re-run
  `npm install` on the host — and vice versa.
- **Services on your host stay reachable.** The `basyx-setup/` compose stack is still easiest to
  run on the host; from inside the container it answers at
  `http://host.docker.internal:<port>`, which is a perfectly good target to point Connect at.
- **The container runs as the unprivileged `node` user and ships no `sudo`.** To try a package out
  temporarily, `docker exec -u root -it <container> apt-get …`; to keep it, add it to the
  Dockerfile and run *Dev Containers: Rebuild Container*, so the next person gets it too.

## Direction: pluggable by design

The architecture treats the load-generation engine as a swappable component behind a
stable interface, rather than something the rest of the tool depends on directly.
Recipes, results and the UI are engine-agnostic; a given engine is just an adapter
that knows how to turn a scenario's benchmark phase into something runnable, and how
to report results back in a common shape. The intent is that the tool can outlive any
single engine choice and grow further adapters later without touching its core.

That interface now exists — the backend hands an adapter the authored timeline, the
adapter compiles it itself, and nothing about plans, scripts, VUs or subprocesses
crosses back over that boundary into the results (ADR 0004). The k6 adapter's
compiled form is expressed in k6's own executor vocabulary (ADR 0002), so each
authored load shape maps straight to one k6 executor; a second engine would bring
its own compiler. **k6** is the one adapter implemented, and deliberately
the only one: further adapters are future work, not scheduled. It runs as an external
subprocess and is never linked in-process, which is a licensing boundary as much as
an architectural one (k6 is AGPL-3.0, and the network-copyleft clause is triggered by
linking, not by invoking a CLI). The decisions and their consequences are recorded in
ADRs 0001–0004 under `docs/adr/`.

## Repository layout

```
frontend/                 React + TypeScript + Vite — the five screens
backend/                  Fastify orchestrator: probe, scenario library, timeline execution
  scenarios/                the shipped demo scenarios, as data
packages/shared-types/    the metamodel, its validator and generated JSON Schema
scripts/                  the dev-stack launcher, the port guard, and the image smoke test
Dockerfile                the deployment image; docker-compose.yml runs it from a checkout
.github/workflows/        CI that builds, smoke-tests and publishes that image
metamodel.puml / .png     the class diagram linked above
architecture.puml / .png  the system diagram linked above
```

`packages/shared-types/` is the point worth knowing about: the frontend and the backend
import the *same* metamodel, validator and wire contract, so the document the Compose
screen's Code view shows is byte-identical to the one the orchestrator validates and
executes. There is no separate export format to keep in sync — that is the design, not
a convenience.

`frontend/`, `backend/` and `backend/scenarios/` each carry their own README describing
what is real, what is stubbed, and why. Read those before changing anything inside them.

The proposal document, the `docs/adr/` decision records and the read-only `stress-forge/`
reference checkout live alongside these in a working checkout but are not committed to
this repository — see `.gitignore`.

## Guiding principles

- Standards-first: all interaction with a target server goes through its
  standardised API, never vendor-specific internals.
- Minimal footprint: the tool's own overhead must never compete with the load
  it is generating.
- Reusable, adaptable, extensible: recipes, target servers and engines should
  all be swappable or extendable without rewriting the core.
