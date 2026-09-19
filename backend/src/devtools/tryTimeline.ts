/**
 * A hands-on way to see the backend's own pipeline work — **development only**, and the fastest
 * way to understand it: no HTTP, no frontend, just the same three calls `POST /api/runs/scenario`
 * makes, made directly from code.
 *
 * It builds a `LoadTimeline` **in code**, from the `@kaigara/shared-types` classes — the same
 * classes the Compose screen's Visual view mutates and the Code view serializes — rather than
 * reading a scenario file, so it is the plainest possible worked example of "what is a timeline,
 * actually". `buildTimeline()` below is two tracks:
 *
 *  - "Purge" — at t=0, an instantaneous burst (`SpikeShape`, the one shape kind modelled as a
 *    single burst rather than a sustained rate) deletes every shell and every submodel already on
 *    the target, at `PURGE_RATE_PER_SEC` — the highest rate `compileTimeline.ts`'s own worker-pool
 *    sizing (`MAX_VUS_CEILING`) can actually put more VUs behind, i.e. the practical "max
 *    requests/sec" this engine models. `idPool: { source: "server" }` is what makes it "every"
 *    rather than "this run's own": the same pool `backend/scenarios/purge-repository.json` uses
 *    for its own teardown.
 *  - "Lifecycle" — the same shape as `backend/scenarios/minimal-crud.json`, starting
 *    `PURGE_DELAY_SECONDS` after the purge starts, so the two do not race on a dev-sized corpus
 *    (see that constant's own comment): create 30 submodels, then create 10 shells — each shell's
 *    own body embeds real references to 3 of the submodels just created, via `RequestReferenceData`
 *    (requestComposition.ts), so `GET`ting a shell back afterward shows genuine `submodels` entries
 *    rather than an empty list. Then read every shell and submodel back by identifier. Every read
 *    below addresses exactly the entities created earlier — the default (`idPool` source
 *    `"created"`, so no explicit `idPool` is authored on those requests at all).
 *
 * Read `buildTimeline()` and change it to try other shapes, operations or generators.
 *
 * ⚠️  **This timeline deletes every shell and submodel already on whatever server you point it
 * at, then creates and deletes some more of its own.** A completed run leaves the target exactly
 * as empty as the purge left it, but an interrupted one (Ctrl-C mid-run) can leave the lifecycle's
 * own created entities behind. Only run it against the stub AAS server or a disposable target —
 * never one with data you want to keep.
 *
 * From there it does exactly what `RunService.create()` does for a real request (see
 * `runs/runService.ts`): resolve the target, hand the adapter the timeline to compile, start it,
 * and stream `RunView` snapshots back — printed here instead of pushed over SSE.
 *
 *   npm run try-timeline -w backend                                   # against the stub AAS server
 *   npm run try-timeline -w backend -- http://localhost:8081/api/v3   # an explicit target
 *   KAIGARA_TRY_TARGET=https://example.org/api/v3 npm run try-timeline -w backend
 *
 * Needs a target to actually talk to — `npm run stub-aas -w backend` in another terminal is the
 * easiest one. k6 must be on `PATH` (or `KAIGARA_K6_BINARY` set), same as the real backend.
 * Ctrl-C stops the run cleanly rather than leaving it orphaned.
 *
 * A target that needs bearer auth (e.g. twinsphere's `twinsphere_ID_OAuth2` service-account flow,
 * client-credentials against its CIAM tenant) is supported without ever putting a secret in this
 * file: set `KAIGARA_TRY_TOKEN_URL`, `KAIGARA_TRY_CLIENT_ID`, `KAIGARA_TRY_CLIENT_SECRET` and
 * `KAIGARA_TRY_SCOPE`, and `resolveAuthHeaders()` below exchanges them for a fresh access token
 * right before the run starts (tokens are short-lived — ~1h for twinsphere — so this always
 * fetches one just in time rather than accepting a pre-fetched token as a fifth env var). Example:
 *
 *   KAIGARA_TRY_TARGET=https://jku.cloud.twinsphere.io/api/v3 \
 *   KAIGARA_TRY_TOKEN_URL=https://twinsphere.ciamlogin.com/<tenant-id>/oauth2/v2.0/token \
 *   KAIGARA_TRY_CLIENT_ID=<service-account client id> \
 *   KAIGARA_TRY_CLIENT_SECRET=<service-account client secret> \
 *   KAIGARA_TRY_SCOPE=api://twinsphere-server-prod-jku-api/.default \
 *   npm run try-timeline -w backend
 *
 * Running this twice in a row against the same target is fine: the second run's purge harvests an
 * already-empty corpus, which by default is only a warning — a per-request setting,
 * `RequestIdPoolData.onEmpty` (see requestComposition.ts), authored below on the purge's own two
 * `RequestSpec`s via `KAIGARA_ON_EMPTY_SERVER_CORPUS` (default `"warn"`; set it to `"fail"` to see
 * the stricter, opt-in alternative instead: the compile itself refuses, with
 * `EmptyServerCorpusError`). In the real app this is what the "Existing on server" identifier
 * strategy's own field sets, in the Compose screen's parameter panel.
 */

import {
  IndividualShape,
  Load,
  LoadTimeline,
  RandomizedGenerator,
  RequestComposition,
  RequestSpec,
  SpikeShape,
  Track,
  type RequestOperation,
  type RequestReferenceData,
  type RequestTargetEntity,
  type RunView,
} from "@kaigara/shared-types";

import { EngineRegistry } from "../engines/adapter.ts";
import { K6Adapter } from "../engines/k6/k6Adapter.ts";
import { RunService } from "../runs/runService.ts";

const TARGET_BASE_URL = process.argv[2] ?? process.env.KAIGARA_TRY_TARGET ?? "http://127.0.0.1:8081/api/v3";
/** `RequestIdPoolData.onEmpty` for the purge's own two requests (see requestComposition.ts) —
 *  whether an already-empty target (e.g. running this twice in a row) is only a warning, the
 *  default, or fails the compile outright. A per-request setting, not a global one: authoring it
 *  here rather than on the lifecycle's requests is a choice `buildTimeline()` makes below, the same
 *  choice a person would make per request in the Compose screen. */
const PURGE_ON_EMPTY = process.env.KAIGARA_ON_EMPTY_SERVER_CORPUS === "fail" ? "fail" : "warn";

// --- Purge: delete everything already on the target, instantly, before anything else runs. ---

/** MAX_VUS_CEILING in compileTimeline.ts's own worker-pool sizing: past this rate, more req/s
 *  buys no more VUs, so it is the highest throughput this engine will actually try to sustain —
 *  the practical "max requests/sec" for an instantaneous burst. */
const PURGE_RATE_PER_SEC = 2000;
/** Large enough to harvest every shell/submodel a dev target could plausibly hold — the same cap
 *  `backend/scenarios/purge-repository.json` uses for its own teardown. */
const PURGE_MAX_IDS = 100_000;
/** Delay before the rest of the timeline starts, as asked — a touch short of the purge's own
 *  nominal window (`INSTANTANEOUS_WINDOW_SECONDS`, 6s), so on a dev-sized corpus (finished well
 *  before that window closes) nothing overlaps in practice; it is a fixed gap, not a wait for the
 *  purge to actually finish. Raise it if `PURGE_MAX_IDS` ever has real work left to do at +5s. */
const PURGE_DELAY_SECONDS = 5;

/** One load: an instantaneous burst that deletes every identifier of `target` already on the
 *  server — `idPool: { source: "server" }` is what draws from the whole target corpus rather than
 *  falling back to this run's own (nonexistent, at t=0) creates. */
function purgeAll(id: string, target: RequestTargetEntity): Load {
  return new Load({
    id,
    startSeconds: 0,
    durationSeconds: 0, // instantaneous shapes carry 0 here; see INSTANTANEOUS_WINDOW_SECONDS
    shape: new SpikeShape({ magnitudeRatePerSec: PURGE_RATE_PER_SEC }),
    requests: new RequestComposition([
      new RequestSpec({
        id: `delete-all-${target}s`,
        operation: "delete",
        target,
        weight: 1,
        generator: new RandomizedGenerator({ sizeBytes: 0 }), // ignored for a delete
        idPool: { source: "server", maxIds: PURGE_MAX_IDS, onEmpty: PURGE_ON_EMPTY },
      }),
    ]),
  });
}

// --- Lifecycle: create some entities, read them back, delete them — see the module doc above. ---

/** How many of each entity the lifecycle carries through create → read → delete. */
const SHELL_COUNT = 10;
const SUBMODEL_COUNT = 30;
/** How many of the submodels each shell's own create body references — see `phase()`'s
 *  `references` parameter. `SUBMODEL_COUNT` split evenly across `SHELL_COUNT`, so every submodel
 *  created ends up referenced by exactly one shell and none are left over. */
const SUBMODELS_PER_SHELL = SUBMODEL_COUNT / SHELL_COUNT;
/** Gap between phases: comfortably past `INSTANTANEOUS_WINDOW_SECONDS` (6s, see loadShape.ts), the
 *  nominal window an `individual` load's one-off requests are spread over, so a phase never starts
 *  before the one before it has actually finished — including, now, between creating the submodels
 *  and creating the shells that reference them: a shell's create body can only name submodels that
 *  already exist, the same "nothing discovered at run time" rule every other script follows. */
const PHASE_GAP_SECONDS = 10;
const TOTAL_DURATION_SECONDS = 45;

/** One load: a literal, one-shot count of one operation against one entity — e.g. "create 10
 *  shells". `IndividualShape` is the one shape kind with a real count rather than a rate; see
 *  loadShape.ts. `references`, only meaningful for a `create`, embeds real identifiers of another
 *  entity this run created earlier into each iteration's own body — see `RequestReferenceData` in
 *  requestComposition.ts. */
function phase(
  id: string,
  startSeconds: number,
  operation: RequestOperation,
  target: RequestTargetEntity,
  count: number,
  references?: RequestReferenceData,
): Load {
  return new Load({
    id,
    startSeconds,
    durationSeconds: 0, // instantaneous shapes carry 0 here; see INSTANTANEOUS_WINDOW_SECONDS
    shape: new IndividualShape({ requestCount: count }),
    requests: new RequestComposition([
      new RequestSpec({
        id: `${operation}-${target}`,
        operation,
        target,
        weight: 1,
        generator: new RandomizedGenerator({ sizeBytes: operation === "create" ? 256 : 0 }), // ignored except by create
        ...(references ? { references } : {}),
      }),
    ]),
  });
}

/** The whole point of this file: build a timeline by calling the shared-types constructors
 *  directly, the same way the frontend's model factories do. See the module doc above for the two
 *  tracks this assembles. */
function buildTimeline(): LoadTimeline {
  const purgeTrack = new Track({
    id: "purge",
    label: "Purge",
    loads: [purgeAll("purge-shells", "shell"), purgeAll("purge-submodels", "submodel")],
  });

  // Submodels first: a shell's create body can only reference ones that already exist.
  const createSubmodelsPhase = PURGE_DELAY_SECONDS;
  const createShellsPhase = createSubmodelsPhase + PHASE_GAP_SECONDS;
  const readPhase = createShellsPhase + PHASE_GAP_SECONDS;
  // const deletePhase = readPhase + PHASE_GAP_SECONDS; // left disabled below — see those lines

  const lifecycleTrack = new Track({
    id: "lifecycle",
    label: "Lifecycle",
    loads: [
      phase("create-submodels", createSubmodelsPhase, "create", "submodel", SUBMODEL_COUNT),
      phase("create-shells", createShellsPhase, "create", "shell", SHELL_COUNT, { target: "submodel", count: SUBMODELS_PER_SHELL }),
      phase("read-shells", readPhase, "read", "shell", SHELL_COUNT),
      phase("read-submodels", readPhase, "read", "submodel", SUBMODEL_COUNT),
      // phase("delete-shells", deletePhase, "delete", "shell", SHELL_COUNT),
      // phase("delete-submodels", deletePhase, "delete", "submodel", SUBMODEL_COUNT),
    ],
  });

  return new LoadTimeline({ totalDurationSeconds: TOTAL_DURATION_SECONDS, tracks: [purgeTrack, lifecycleTrack] });
}

function printView(view: RunView): void {
  const { status, plan, metrics, state } = view;
  // The last point of the live req/s series (see MetricsAggregator) — the same number the Run
  // screen's sparkline would be drawing right now.
  const currentRatePerSec = state.requestsPerSecondSeries.at(-1) ?? 0;
  console.log(
    `  [${formatElapsed(state.elapsedSeconds)}] ${status.padEnd(10)} ` +
      `requests=${metrics.requests} failed=${metrics.failed} ` +
      `p95=${metrics.percentiles.p95.toFixed(1)}ms ` +
      `rate=${currentRatePerSec.toFixed(1)}/s of ${plan.expectedRequests} expected total`,
  );
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** OAuth2 client-credentials exchange for a target that needs bearer auth — see the module doc's
 *  `KAIGARA_TRY_TOKEN_URL` example. Returns `{}` (no auth) when those env vars aren't set, which
 *  keeps the stub-AAS default working unchanged. Never accepts a pre-fetched access token itself:
 *  the whole point is that nothing long-lived or secret sits in this file or its argv. */
async function resolveAuthHeaders(): Promise<Record<string, string>> {
  const tokenUrl = process.env.KAIGARA_TRY_TOKEN_URL;
  if (!tokenUrl) return {};

  const clientId = process.env.KAIGARA_TRY_CLIENT_ID;
  const clientSecret = process.env.KAIGARA_TRY_CLIENT_SECRET;
  const scope = process.env.KAIGARA_TRY_SCOPE;
  if (!clientId || !clientSecret || !scope) {
    throw new Error(
      "KAIGARA_TRY_TOKEN_URL is set but KAIGARA_TRY_CLIENT_ID / KAIGARA_TRY_CLIENT_SECRET / KAIGARA_TRY_SCOPE are not all present.",
    );
  }

  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope });
  const response = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) {
    throw new Error(`Token exchange against ${tokenUrl} failed: HTTP ${response.status} ${await response.text()}`);
  }
  const { access_token: accessToken } = (await response.json()) as { access_token?: string };
  if (!accessToken) throw new Error(`Token exchange against ${tokenUrl} did not return an access_token.`);

  console.log(`Fetched a fresh access token from ${tokenUrl}.`);
  return { Authorization: `Bearer ${accessToken}` };
}

async function main(): Promise<void> {
  const timeline = buildTimeline();
  const authHeaders = await resolveAuthHeaders();
  console.log(`Target:   ${TARGET_BASE_URL}`);
  console.log("Timeline (LoadTimeline.toJSON() — byte-identical to what the Compose Code view would show):");
  console.log(JSON.stringify(timeline.toJSON(), null, 2));

  // Exactly how server.ts wires it: one registry, one adapter, one service. No Fastify, no HTTP —
  // this is the object graph underneath POST /api/runs/scenario, called directly.
  const engines = new EngineRegistry();
  engines.register(new K6Adapter());
  const runs = new RunService(engines);

  console.log("\nCompiling and starting the run...");
  let view = await runs.create({
    timeline: timeline.toJSON(),
    target: { baseUrl: TARGET_BASE_URL, headers: authHeaders },
    scenarioName: "dev/try-timeline",
  });
  console.log(`Run ${view.id} — plan: ${view.plan.loadCount} load(s), ${view.plan.expectedRequests} requests expected over ${view.plan.totalDurationSeconds}s.`);
  if (view.warnings.length > 0) {
    console.log("Warnings from compilation:");
    for (const warning of view.warnings) console.log(`  - [${warning.path}] ${warning.message}`);
  }

  let stopping = false;
  const stopOnSignal = () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping the run...");
    void runs.stop(view.id);
  };
  process.on("SIGINT", stopOnSignal);

  try {
    // No SSE client here, so this polls the same RunView the HTTP layer and the frontend read —
    // runs.subscribe() exists for the push side (see routes/runs.ts's /events handler).
    while (view.status === "starting" || view.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      view = runs.get(view.id);
      printView(view);
    }
  } finally {
    process.off("SIGINT", stopOnSignal);
  }

  console.log(`\nFinished: ${view.status}`);
  if (view.error) console.log(`Error: ${view.error}`);
  console.log(
    `Requests: ${view.metrics.requests} sent, ${view.metrics.failed} failed, ` +
      `mean ${view.metrics.meanDurationMs.toFixed(1)}ms, p95 ${view.metrics.percentiles.p95.toFixed(1)}ms.`,
  );
  if (Object.keys(view.metrics.byStatus).length > 0) {
    console.log(`By HTTP status: ${JSON.stringify(view.metrics.byStatus)}`);
  }
  if (view.artifacts.length > 0) {
    console.log(`Artifacts (fetchable via GET /api/runs/${view.id}/artifacts/<name> when this ran through the real server):`);
    for (const artifact of view.artifacts) console.log(`  - ${artifact.name} (${artifact.contentType}): ${artifact.description}`);
  }
  if (view.engineLog.length > 0) {
    console.log("Last engine log lines:");
    for (const line of view.engineLog.slice(-5)) console.log(`  ${line}`);
  }

  process.exitCode = view.status === "completed" || view.status === "stopped" ? 0 : 1;
}

main().catch((error) => {
  console.error("\ntry-timeline failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
