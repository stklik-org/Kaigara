# Kaigara backend

A thin TypeScript/Fastify orchestrator, per `AAS-Benchmarking-Tool-Proposal.md` §5.1/§5.3. Three
slices are real; the rest is still the shape it will grow into.

Run it with `npm run dev -w backend` (Node >= 22.6 strips the TypeScript natively — there is no
build step). It listens on `127.0.0.1:5174`; override with `PORT`/`HOST`. To point the frontend at
it instead of the in-process middleware, start Vite with
`KAIGARA_BACKEND_URL=http://127.0.0.1:5174` — **required for running benchmarks**, since the dev
server only mounts the connection probe and the scenario library in-process.

## Implemented

### Connection probe

`POST /api/connections/test` with `{ baseUrl, timeoutSeconds? }` returns a `ConnectionTestResult`.
It asks the target server for its IDTA-01002 Service Description (`GET {baseUrl}/description`),
falling back to `GET {baseUrl}/shells` for servers that do not implement it, and reports latency,
HTTP status, the advertised conformance profiles, and a classified error (DNS / refused / TLS /
timeout / HTTP) when it fails. Standards-only: no vendor health endpoints. Logic lives in
`src/connections/probe.ts` and is deliberately free of Fastify, so the Vite dev server can mount
the same function in-process (`frontend/vite.config.ts`).

### Scenario library

`GET /api/scenarios` lists a folder of serialized scenario documents and `GET /api/scenarios/:id`
serves one — the Load screen's library. The folder is `backend/scenarios/` unless
`KAIGARA_SCENARIOS_DIR` says otherwise, and it ships five demo scenarios: a showcase of every load
shape, a persistence-latency probe, and the three StressForge profiles. See
`backend/scenarios/README.md` for what each one is and, for the StressForge three, exactly which
parts of the original profile survived the translation.

Recipes are data, not code (§4.2), so the library is a **directory**: adding a scenario is copying
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
| `POST /api/runs/compile` | Same body; compiles and returns the generated engine script **without running it**. |
| `GET /api/runs` / `GET /api/runs/:id` | Run list / one run. |
| `GET /api/runs/:id/events` | Live `RunView` over Server-Sent Events. |
| `POST /api/runs/:id/stop` | Graceful stop (SIGINT — in-flight iterations finish and the summary is still written). |
| `GET /api/runs/:id/artifacts/:name` | `script.js` or `plan.json` — exactly what was executed. |
| `GET /api/engines` | Which adapters are installed, with versions. |

The pipeline, in order:

1. **Validate** (`@kaigara/shared-types`'s `collectLoadTimelineIssues`) — the same validator the
   Compose Code view uses. Errors reject the request with 422 and a per-path issue list; warnings
   ride along on the run so the user can see why it may not do what they expected.
2. **Compile to an `ExecutionPlan`** (`src/timeline/`) — engine-neutral. Each `LoadShape` is
   sampled through its own `rateAt()` into a piecewise-linear rate curve, which is what keeps the
   Compose "expected requests" overlay and the actual run in agreement. Each `RequestSpec` becomes
   a concrete IDTA-01002 call (`src/timeline/aasOperations.ts`) with its weight folded into a
   cumulative distribution.
3. **Render for an engine and run it** (`src/engines/k6/`) — see below.
4. **Aggregate** (`src/runs/metricsAggregator.ts`) — per-second buckets and a bounded latency
   reservoir, so raw per-request events never reach the browser (proposal §7.2).

Runs are held **in memory**: they do not survive a restart. SQLite-backed history (proposal §10)
is the next step, and `RunService` is the only place that changes.

## Engine adapters — Option C, k6 first

Per ADR 0001, the "compile → run → parse" step sits behind the `EngineAdapter` interface in
`src/engines/adapter.ts`. An adapter receives an `ExecutionPlan` and emits `RequestSample`s;
nothing about scripts, VUs or subprocesses crosses that boundary. Only the **k6** adapter is
implemented — do not build others speculatively.

How the k6 adapter works, and why:

- **k6 runs as an external subprocess, never linked.** That is a licensing constraint: k6 is
  AGPL-3.0 and the network-copyleft clause is triggered by linking, not by invoking a CLI
  (proposal §3.1/§12). No file in this package imports k6.
- The generated script (`src/engines/k6/compileScript.ts`) embeds the plan as a JSON constant and
  interprets it with a small fixed runtime, rather than unrolling per-request code — so it stays
  short enough to read, which matters because `POST /api/runs/compile` hands it to the user.
- Rate curves become `constant-arrival-rate` (flat), `ramping-arrival-rate` (curved, one stage per
  plan segment), or `shared-iterations` (the timeline's "Individual" shape, which is a literal
  request count that no rate can express).
- Results come from `--out json`, written to a file and tailed incrementally.
- **Identifier pools.** `update`/`delete` need an id that exists on the server. `setup()` pages in
  existing ids, and each VU remembers what it created. Requests with no id available are counted
  (`kaigara_skipped_no_id`) and reported rather than silently dropped.
- **Dropped iterations are surfaced prominently.** A non-zero `dropped_iterations` means k6's
  worker pool was saturated — the *tool* was the bottleneck, not the server — which invalidates
  the measurement. VU sizing is an estimate (`rate × assumed latency`), because the real latency
  is the thing being measured.
- The script's own setup requests are tagged and excluded from the results, so Kaigara's
  bookkeeping never lands in the numbers it reports.

### Payload generation

`Randomized` builds real IDTA-01001-shaped entities (an `AssetAdministrationShell` with
`assetInformation`, or a `Submodel` with `submodelElements`), padded to the requested size through
a legitimate field — a server that validates its input must be able to accept them, or the
benchmark would only measure the rejection path. `Mutate` rewrites a share of the leaves of a base
payload. `Exact` is sent **verbatim**, including an id that may not match the URL: it is the
negative-testing escape hatch the proposal (§9.1) asks for, so repairing it would remove the only
way to author such a case.

## Not implemented

- The `preparation`, `preconditions`, `postconditions` and `cleanup` phases. Only `method` runs;
  the others report status `skipped` rather than `done`, so a clean run is never mistaken for
  "correctness checks passed".
- Saving a scenario back to the library (it is read-only — a scenario is stored by writing a file
  into the folder) and run history (proposal §10), connection ownership (still `localStorage` in
  the frontend), correctness checking via `aas-test-engines`/ajv (§8), and resource-usage
  correlation (§7.3).

## Development helper

`npm run stub-aas -w backend` starts a **development-only** in-memory stand-in for an AAS server on
`:8081` (API root `http://127.0.0.1:8081/api/v3`), implementing just enough of the repository
surface to exercise this pipeline end to end without twinsphere or a BaSyx container. It validates
almost nothing and is not an AAS implementation. `SEED_COUNT` and `LATENCY_MS` tune it.

## Layout

```
scenarios/              # the shipped scenario library (data — see its own README)
src/
  server.ts             # Fastify app + route registration
  connections/probe.ts  # reachability / conformance probe
  scenarios/library.ts  # folder-backed scenario library
  timeline/             # LoadTimeline -> engine-neutral ExecutionPlan
    executionPlan.ts    #   the IR
    compilePlan.ts      #   shape -> rate curve, RequestSpec -> HTTP
    aasOperations.ts    #   (operation x entity) -> IDTA-01002 endpoint table
  engines/
    adapter.ts          # EngineAdapter interface + registry (ADR 0001)
    k6/                 #   the only adapter: script generation, subprocess, output parsing
  runs/
    runService.ts       # orchestration + RunState projection
    metricsAggregator.ts
  routes/
    runs.ts
    scenarios.ts
  devtools/             # stub AAS server (development only)
```

## Shared types

Domain types live in `packages/shared-types` and are imported by both this package and the
frontend so the two cannot drift. `runExecution.ts` is the wire contract for the endpoints above;
note that it mentions no engine vocabulary beyond `engineId`, which names an adapter rather than
describing one.

Its internal imports carry explicit `.ts` extensions so this package can consume it under plain
`node` with no build step.
