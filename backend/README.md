# Kaigara backend

A thin TypeScript/Fastify orchestrator. Three slices are real — the connection probe, the scenario
library and timeline execution — and the rest is still the shape it will grow into.

## Running it

Node >= 22.6 strips the TypeScript natively, so there is no build step. Running a benchmark also
needs the `k6` binary on `PATH` (or named by `KAIGARA_K6_BINARY`). The Dev Container
(`../.devcontainer/`, see the root README) carries both, pinned.

```bash
npm run dev                  # from the repo root: this + the stub AAS server + the frontend, wired up
npm run dev -w backend       # this process alone on 127.0.0.1:5174, restarting on file changes
npm start -w backend         # the same without --watch
npm run stub-aas -w backend  # the development-only AAS stand-in on :8081 (see below)
npm run stop                 # from the repo root: free 5173 / 5174 / 8081
```

`PORT`/`HOST` move the listener. `dev`, `start` and `stub-aas` each run `../scripts/ports.mjs` as a
`pre*` hook and refuse a port that is already taken, naming the process that holds it. This matters
because a second orchestrator under `node --watch` keeps its supervisor alive after a failed
`listen`, so it looks like it is running while requests still reach the first copy. To run a
second one on purpose, use `PORT=5175 npm start -w backend`.

The frontend reaches this process through Vite's `/api` proxy when Vite is started with
`KAIGARA_BACKEND_URL=http://127.0.0.1:5174` (the root `npm run dev` sets it). That is **required
for running benchmarks**. Without it the dev server mounts only the probe and the scenario library
in-process. A deployed build doesn't use Vite at all: this process serves the UI itself (see
[Serving the UI](#serving-the-ui)).

**<http://127.0.0.1:5174/swagger>** is Swagger UI over everything below, and is the fastest way to
drive the backend without the frontend — see [API docs](#api-docs).

## Implemented

### Connection probe

`POST /api/connections/test` with `{ baseUrl, timeoutSeconds?, headers? }` returns a
`ConnectionTestResult`. It asks the target server for its IDTA-01002 Service Description
(`GET {baseUrl}/description`), falling back to `GET {baseUrl}/shells` for servers that do not
implement it, and reports latency, HTTP status, the advertised conformance profiles, and a
classified error (DNS / refused / TLS / timeout / HTTP) when it fails. Standards-only: no vendor
health endpoints. Logic lives in `src/connections/probe.ts` and is deliberately free of Fastify, so
the Vite dev server can mount the same function in-process (`frontend/vite.config.ts`).

`headers` is whatever a `ServerConnection` carries in the frontend's `localStorage` — an
`Authorization` bearer token, an API key, anything the target wants verbatim on every request. It
is sent on the probe and, via `RunTarget.headers`, on every request an actual run issues, so "Test"
and "Run" always see the same server. There is no token-exchange support: a value here has to
already be what the server accepts (a static key, or a bearer token refreshed by hand), not a
client secret needing an OAuth2 client-credentials exchange.

### Scenario library

`GET /api/scenarios` lists a folder of serialized scenario documents and `GET /api/scenarios/:id`
serves one — the Load screen's library. The folder is `backend/scenarios/` unless
`KAIGARA_SCENARIOS_DIR` says otherwise. It ships seven demo scenarios: a showcase of every load
shape, a minimal CRUD lifecycle, a persistence-latency probe, a best-effort purge of the target
repository, and the three StressForge profiles. `purge-repository` DELETEs whatever it finds on
the target, so check where it points before running it. See `backend/scenarios/README.md` for what
each scenario is and, for the StressForge three, exactly which parts of the original profile
survived the translation.

Recipes are data, not code, so the library is a **directory**: adding a scenario is copying
a file in, and there is no write endpoint. Files are read through `parseScenarioDocument` from
`@kaigara/shared-types` — the same reader the Load screen's drop zone uses — so a file the library
serves is exactly a file a user could have dropped in by hand. A file that fails to parse is
listed with its issues rather than omitted, because "my scenario is missing" is a worse answer
than a named offending property.

Logic lives in `src/scenarios/library.ts` and, like the probe, is free of Fastify: the Vite dev
server mounts the same functions in-process, so `npm run dev -w frontend` alone shows a populated
Load screen.

### Timeline execution

`POST /api/runs` takes a serialized `LoadTimeline` — the exact document the Compose screen's Code
view shows — and executes it against a target AAS server.

| Endpoint | Purpose |
|---|---|
| `POST /api/runs` | `{ timeline, target: { baseUrl, timeoutSeconds?, headers? }, scenarioName?, connectionId?, engineId?, dryRun? }` → validate, compile, execute. Returns a `RunView`. |
| `POST /api/runs/scenario` | Same, but with `scenario` (a whole scenario document) or `scenarioId` (a file stem from the library) in place of `timeline`. |
| `POST /api/runs/compile` | Same body; compiles and returns the plan and every generated engine file (`main.js` plus one script per request type) **without running it**. |
| `POST /api/runs/concrete-plan` | Same body; returns the per-load schedule behind the Run screen's *Concrete plan* view — executor, window and rate per load, and the expected count of each request type. Sends nothing. |
| `GET /api/runs` / `GET /api/runs/:id` | Run list, newest first / one run. |
| `GET /api/runs/:id/events` | Live `RunView` over Server-Sent Events: a `state` event about once a second, then `end`. |
| `POST /api/runs/:id/stop` | Graceful stop (SIGINT — in-flight iterations finish and the summary is still written). |
| `GET /api/runs/:id/artifacts/:name` | `main.js`, one of the numbered scripts, or `plan.json` — exactly what was executed. |
| `GET /api/engines` | Which adapters are installed, with versions. |

(`GET /api/health` answers `{ ok, service }`, and is the one endpoint that touches nothing else.)

The pipeline, in order. `RunService.create()` resolves the target and hands the adapter the
**authored timeline** — there is no intermediate plan built outside the adapter:

1. **Compile, inside the adapter** (`K6Adapter.compile()`, all under `src/engines/k6/`):
   - *Validate* (`compileTimeline.ts`, via `@kaigara/shared-types`'s `collectLoadTimelineIssues`) —
     the same validator the Compose Code view uses. Errors reject the request with 422 and a
     per-path issue list; warnings ride along on the run.
   - *Split* (`compileTimeline.ts`) — each `LoadShape` maps one to one to a k6 executor:
     `constant`/`spike` → `constant-arrival-rate`, `ramp` → a one-stage `ramping-arrival-rate`,
     `individual` → `shared-iterations`; `sine`/`bell` are sampled through their own `rateAt()` into
     a multi-stage ramp, since k6 has no curved executor. That executor is then **scaled by each
     request type's weight share** into one script per (load × request type): a 70/30 read/create
     load at 100 req/s becomes a 70 req/s read script and a 30 req/s create script, and an
     `individual` load's literal count is split by largest remainder so the parts add back up
     exactly. Each `RequestSpec` becomes a concrete IDTA-01002 call
     (`src/timeline/aasOperations.ts`). The result is a `K6Plan`, which never leaves `engines/k6/`.
   - *Design the request pools* (`compileTimeline.ts` + `harvestIdentifiers.ts`) — harvest the
     target once per entity, then walk the scripts in schedule order deciding the literal
     identifiers each addresses: a create mints its own, a delete claims what it removes, and a
     read/update cycles over what is alive for its whole window.
   - *Render* (`scriptTemplates.ts`) — one small standalone file per script, plus the thin
     `main.js` that schedules them all in one k6 process.
   - Return a `CompiledRun`: the artifacts, the warnings, and a thin `CompiledRunSummary`
     (scenario name, duration, expected requests, one key/label per load) — all `RunService` needs.
2. **Run it** (`K6Adapter.start()`) — see below.
3. **Aggregate** (`src/runs/metricsAggregator.ts`) — per-second buckets and a bounded latency
   reservoir, so raw per-request events never reach the browser.

A compile that throws never becomes a run: `RunService` inserts the run record only after
`compile()` succeeds, and removes the work directory if it does not.

`POST /api/runs/scenario` is a wrapper on that same path, not a second pipeline: it resolves a
scenario document down to its `method` timeline and hands *that* to `RunService.create`. It exists
because the unit a user has is a file — one they wrote, or one already in the library — and digging
`phases.method` out of it by hand before every run is friction with no purpose. Both routes into it
go through `parseScenarioDocument`, so a document it runs is exactly a document the Load screen
would open. Give it exactly one of `scenario` or `scenarioId`; neither or both is a 400.

Runs are held **in memory**: they do not survive a restart. Their generated inputs and raw engine
output do hit the disk — each run gets a directory under `<os tmpdir>/kaigara-runs/<run id>/`
holding `main.js`, the numbered scripts, `plan.json`, the engine's NDJSON metric stream and its
summary — which is what
`GET /api/runs/:id/artifacts/:name` serves. SQLite-backed history is the next step,
and `RunService` is the only place that changes.

That tmp directory is swept by the OS, so the k6 adapter also keeps a **persistent archive** under
`KAIGARA_LOG_DIR` (default `<cwd>/k6-logs`): one folder per backend process, named by its start time
(`k6-logs/2026-09-10_143002/`). Inside it, one folder per run holding exactly the files k6 was
handed — `main.js`, every numbered script, `plan.json` (headers redacted) and an `artifacts/`
subfolder with the request payloads fixed at compile time (Exact bodies, Mutate base bodies) — and
an `ExecutionPlan.txt` with one block per run: when k6 was called, the exact `k6 run …` command
line, a `cd … && k6 run …` line that re-runs it from that folder, and the schedule of which script
starts when. See `src/engines/k6/runArchive.ts`; it never fails a benchmark if the disk is full.

## Engine adapters — Option C, k6 first

The "compile → run → parse" step sits behind the `EngineAdapter` interface in
`src/engines/adapter.ts`. An adapter is handed the authored timeline (plus the resolved target) and
compiles it itself, returning a `CompiledRun` and later emitting `RequestSample`s; nothing about
plans, scripts, VUs or subprocesses crosses that boundary. A second engine would bring its own
compiler — what it shares with k6 is the timeline metamodel, the IDTA-01002 endpoint table
(`src/timeline/aasOperations.ts`) and the weight arithmetic (`src/timeline/requestShares.ts`), not
k6's execution model. The engine-agnostic `RunState`/`RunAnalysis` are unchanged. Only the **k6**
adapter is implemented.

`POST /api/runs/compile` and `POST /api/runs/concrete-plan` are inspection-only, so `RunService`
calls k6's `compileTimeline()`/`planTimeline()`/`buildConcretePlan()` directly rather than through
the adapter interface. `plan.json` is the k6 adapter's own compiled form. (`planTimeline()` is the
synchronous half — validate, split, schedule — so the concrete-plan view contacts the target not
at all.)

How the k6 adapter works:

- k6 runs as an external subprocess, never linked in-process. No file in this package imports k6.
- `src/engines/k6/scriptTemplates.ts` renders one small standalone file per request type —
  constants, an `EXECUTOR`, a `const IDS = [...]` list, a `requestFor(i)` generator and a `run()`.
  Each is runnable on its own (`k6 run k6_<track>_<load>_<request-spec>.js`), because k6 ignores an
  imported module's `options` and default export. `main.js` imports them all and schedules each as
  one k6 scenario at its load's `startTime`.
- `requestFor(i)` is indexed by `exec.scenario.iterationInTest`, k6's *global* iteration number for
  the scenario — not a per-VU generator, which would restart per VU and let two VUs create the same
  identifier.
- Executor selection happens in `src/engines/k6/compileTimeline.ts`, one k6 executor per authored
  shape, scaled per request type. A `Constant 100 req/s for 60s` load with one request type is a
  single `constant-arrival-rate` scenario, not a sampled curve. A share that is not a whole number
  of requests per second is expressed per minute (`rate: 200, timeUnit: "1m"`).
- Target headers never enter a generated file: they reach k6 through the `KAIGARA_HEADERS`
  environment variable, and `plan.json` is redacted wherever it is written or returned.
- Results come from `--out json`, written to a file and tailed incrementally.
- **Identifiers are resolved by the backend, and assigned per script.** `update`/`delete` need an id
  that exists on the server, and `create` needs one that does not yet.
  `src/engines/k6/harvestIdentifiers.ts` pages the target **before anything is written**, and
  `compileTimeline.ts` decides which identifiers each script gets, walking the timeline in schedule
  order: a create's output is addressable only by scripts that start after its executor window
  closes, a delete claims what it removes so nothing later addresses it, and a read/update cycles
  over what is alive for its whole window. A script never discovers anything at run time — it reads
  its own `IDS` array. Iterations with nothing left to address are counted
  (`kaigara_skipped_no_id`) and reported rather than silently dropped, and the compile warns about
  them up front; an explicit `idPool.source: "server"` request whose entity harvests to nothing
  fails the compile (400).
- A non-zero `dropped_iterations` in the summary means k6's own worker pool was saturated — the
  tool was the bottleneck, not the server. VU sizing is an estimate (`rate × assumed latency`).
- The scripts issue no requests beyond the authored ones (there is no `setup()`), and anything
  arriving without a `load` tag is excluded by the parser.

### Payload generation

`Randomized` builds real IDTA-01001-shaped entities (an `AssetAdministrationShell` with
`assetInformation`, or a `Submodel` with `submodelElements`), padded to the requested size through
a legitimate field — a server that validates its input must be able to accept them, or the
benchmark would only measure the rejection path. `Mutate` rewrites a share of the leaves of a base
payload. `Exact` is sent **verbatim**, including an id that may not match the URL: it is the
negative-testing escape hatch, so repairing it would remove the only
way to author such a case.

## Serving the UI

When `KAIGARA_UI_DIR` points at the frontend's build output (`frontend/dist`), this process also
serves the UI, from the same origin as the API. The frontend calls the API with relative
`/api/...` paths, so this removes the proxy, the CORS setup and any build-time base URL in one
step. It is what lets the root `Dockerfile` ship as **one image on one port**:
`docker compose up --build` gives <http://localhost:5174>, and `--profile demo` adds the stub AAS
server next to it. The root README covers the image itself.

Any GET that is neither `/api/...` nor a file on disk is answered with `index.html`, so a deep link
like `/compose` resolves in the browser, while a mistyped API path still gets its JSON 404. If the
directory does not exist, the server logs a warning and serves the API only. The variable is unset
in development, and nothing changes there.

## API docs

`GET /swagger` serves Swagger UI; `GET /swagger/json` is the raw OpenAPI 3.1 document. The point is to
make this process usable on its own: pick an endpoint, press *Try it out*, press *Execute*. A
benchmark end to end, without touching the frontend:

```bash
npm run dev -w backend        # terminal 1
npm run stub-aas -w backend   # terminal 2 (or aim at a real server)
# then open http://127.0.0.1:5174/swagger
```

1. `GET /api/engines` — is k6 installed? A missing binary is a setup problem, not a benchmark result.
2. `POST /api/runs/scenario` — the body is pre-filled with
   `{ "scenarioId": "shape-showcase", "target": { … }, "dryRun": true }`. Drop the `dryRun` to
   actually run it, or replace `scenarioId` with a `scenario` document of your own.
3. `GET /api/runs/{id}` to follow it; `GET /api/runs/{id}/artifacts/main.js` to read exactly what
   was executed.

Two things about how it is wired, both in `src/routes/apiSchemas.ts`:

- **The timeline schema is imported, not restated.** `components.schemas` hoists the definitions out
  of `loadTimelineSchema` — the same object that generates
  `packages/shared-types/schema/load-timeline.schema.json` and drives the Compose editor's squiggles.
  Swagger UI therefore shows the shape the validator actually enforces, and a new metamodel field
  turns up in the docs for free.
- **Documentation is not validation.** Fastify would happily use a route's `schema` to validate the
  body with Ajv and serialize the response with fast-json-stringify. It must not: rejection belongs
  to `loadTimelineValidation.ts` / `scenarioDocument.ts`, which answer 422 with the per-path issue
  list the editor renders, and a response serializer would silently drop any `RunView` field the
  docs had not enumerated. So `documented()` attaches the schema and turns both compilers off.

`test/openapi.test.ts` guards what tends to rot: every route documented, every `$ref` resolvable,
and the pre-filled example bodies still valid and compilable — an example that no longer runs is
worse than no example, because the first thing a new user does is press Execute.

## Not implemented

- The `preparation`, `preconditions`, `postconditions` and `cleanup` phases. Only `method` runs;
  the others report status `skipped` rather than `done`, so a clean run is never mistaken for
  "correctness checks passed".
- Saving a scenario back to the library (it is read-only — a scenario is stored by writing a file
  into the folder) and run history, connection ownership (still `localStorage` in
  the frontend), correctness checking via `aas-test-engines`/ajv, and resource-usage
  correlation.
- Access control on the orchestrator itself. There is no authentication, CORS accepts any origin,
  and anyone who can reach the port can make it run k6 against any URL. It binds `127.0.0.1` by
  default, but the Docker image binds `0.0.0.0`, so don't publish that port anywhere untrusted.

## Development helper

`npm run stub-aas -w backend` starts a **development-only** in-memory stand-in for an AAS server on
`:8081` (API root `http://127.0.0.1:8081/api/v3`), implementing just enough of the repository
surface to exercise this pipeline end to end without twinsphere or a BaSyx container. It validates
almost nothing and is not an AAS implementation. It seeds `SEED_COUNT` shells and submodels so that
update/delete have something to address on a cold start. `LATENCY_MS` adds artificial latency and
`BASE_PATH` moves the API root. Like the orchestrator it reads `PORT`/`HOST`, and there `PORT`
defaults to 8081.

The root `npm run dev` starts it alongside everything else (`--no-stub` leaves it out), and
`docker compose --profile demo` runs it as a second container. Remember that a target on the same
machine as the load generator competes with it for CPU. That's fine for a walkthrough and
meaningless as a measurement.

## Environment

| Variable | Applies to | Default |
|---|---|---|
| `PORT` / `HOST` | the orchestrator | `5174` / `127.0.0.1` (the Docker image: `0.0.0.0`) |
| `KAIGARA_SCENARIOS_DIR` | the scenario library | `backend/scenarios/` |
| `KAIGARA_UI_DIR` | serving the built frontend | unset — API only |
| `KAIGARA_K6_BINARY` | the k6 adapter | `k6` on `PATH` |
| `KAIGARA_LOG_DIR` | the k6 run archive | `<cwd>/k6-logs` |
| `PORT` / `HOST` / `SEED_COUNT` / `LATENCY_MS` / `BASE_PATH` | the stub AAS server | `8081` / `127.0.0.1` / `50` / `0` / `/api/v3` |

`KAIGARA_K6_BINARY` is the escape hatch when k6 is installed somewhere `PATH` does not reach; the
adapter probes for it before a run is accepted, so a missing binary is reported as a setup problem
rather than a failed benchmark. `GET /api/engines` asks the same question on demand.

The Dev Container sets `HOST=0.0.0.0` for both Node servers, because a loopback bind inside a
container is unreachable from a published port.

## Tests

```bash
npm test -w @kaigara/backend          # node --test over test/*.test.ts: no framework, no build step
npm run typecheck -w @kaigara/backend
```

| File | What it guards |
|---|---|
| `compileTimeline.test.ts` | Each load shape's k6 executor (ADR 0002), the split into one script per request type at its share of the rate (ADR 0005), the IDTA-01002 endpoint mapping, the timeline-aware identifier walk (create → read → delete, server sources, empty corpora), and generated files that are valid JavaScript and carry no credentials. |
| `engineAdapter.test.ts` | The ADR 0004 seam: the adapter compiles the authored timeline itself and hands back a thin summary, and a failed compile is never recorded as a run. |
| `openapi.test.ts` | Every route documented, every `$ref` resolvable, the pre-filled examples valid and compilable, and rejection done by the domain validator rather than Fastify's. |
| `parseOutput.test.ts` | k6's `--out json` stream and summary → `RequestSample`s and totals, including excluded setup requests, dropped iterations and lines split across chunks. |
| `scenarioLibrary.test.ts` | Every file in `scenarios/` loads, validates and gives each track its own palette colour; broken files are listed rather than dropped, and an id cannot escape the folder. |

Dropping a scenario into `scenarios/` is covered automatically: the library test picks up every
file there.

## Layout

```
scenarios/              # the shipped scenario library (data — see its own README)
test/                   # node --test suites, see above
src/
  server.ts             # Fastify app, route registration, the static UI when KAIGARA_UI_DIR is set
  connections/probe.ts  # reachability / conformance probe
  scenarios/library.ts  # folder-backed scenario library
  timeline/             # engine-neutral pieces any adapter would share (ADR 0004)
    aasOperations.ts    #   (operation x entity) -> IDTA-01002 endpoint table
    requestShares.ts    #   a load's expectedRequests -> per-request share (plain weight arithmetic)
  engines/
    adapter.ts          # EngineAdapter interface + registry; CompiledRun / CompiledRunSummary (ADR 0001, 0004)
    k6/                 #   the only adapter — compiles the timeline itself, runs k6, parses output
      k6Adapter.ts      #   compile(timeline) -> CompiledRun; start() spawns the k6 binary
      k6Plan.ts         #   K6Plan: loads -> scripts, executors, identifier lists (internal)
      compileTimeline.ts #  the compiler: validate, split per request type, design the id
                        #   pools, render (ADR 0002/0003/0005)
      harvestIdentifiers.ts # compile-time harvest of what is already on the target (ADR 0003)
      scriptTemplates.ts #  per-operation script templates + the thin main.js
      concretePlan.ts   #   K6Plan -> the Run screen's per-load debug view
      runArchive.ts     #   persistent k6-logs/ archive: scripts, plans, ExecutionPlan.txt, payloads
      parseOutput.ts    #   --out json stream -> RequestSamples
  runs/
    runService.ts       # orchestration + RunState projection
    metricsAggregator.ts
  routes/
    runs.ts
    scenarios.ts
    openapi.ts          # Swagger + Swagger UI registration
    apiSchemas.ts       #   the OpenAPI vocabulary, and `documented()`
  devtools/
    stubAasServer.ts    # in-memory AAS stand-in (development only)
```

The port guards `npm run dev`/`start`/`stub-aas` run first live one level up, in
`../scripts/ports.mjs`, next to the root `dev.mjs`/`stop.mjs` that use them.

## Shared types

Domain types live in `packages/shared-types` and are imported by both this package and the
frontend so the two cannot drift. `runExecution.ts` is the wire contract for the endpoints above;
note that it mentions no engine vocabulary beyond `engineId`, which names an adapter rather than
describing one.

Its internal imports carry explicit `.ts` extensions so this package can consume it under plain
`node` with no build step.

The class diagram of that metamodel is `../metamodel.puml` / `../metamodel.png`, and where this
process sits in the whole is `../architecture.puml` / `../architecture.png`.
