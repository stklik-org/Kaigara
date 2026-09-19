/**
 * HTTP surface for compiling and executing a timeline.
 *
 * `POST /api/runs` is the endpoint the Compose screen's Run button posts a serialized timeline to.
 * Everything else exists to make that one honest: `/compile` shows what a timeline *would* do
 * without running it, `/events` streams the run live, `/artifacts/:name` hands back the exact
 * script that was executed, and `/engines` answers "is k6 even installed" before a user discovers
 * it is not by watching a run fail. `POST /api/runs/scenario` is the same execution path reached
 * with a *scenario document* instead of a bare timeline, for callers holding a file rather than a
 * composed editor state — Swagger UI, `curl`, a hand-written recipe.
 *
 * Every route carries an OpenAPI schema, attached through `documented()` so it describes the
 * endpoint without becoming a second validator; see `apiSchemas.ts`.
 */

import type { FastifyInstance } from "fastify";

import {
  ScenarioFileError,
  TimelineValidationError,
  scenarioFromParsed,
  type LoadTimelineData,
} from "@kaigara/shared-types";
import type { EngineRegistry } from "../engines/adapter.ts";
import type { K6RunArchive } from "../engines/k6/runArchive.ts";
import { ScenarioNotFoundError, readScenario } from "../scenarios/library.ts";
import {
  EmptyPlanError,
  EmptyServerCorpusError,
  EngineUnavailableError,
  InvalidTargetError,
  RunNotFoundError,
  type CreateRunRequest,
  type RunService,
  type RunView,
} from "../runs/runService.ts";
import {
  EXAMPLE_TARGET,
  EXAMPLE_TIMELINE,
  LOAD_TIMELINE_REF,
  documented,
  errorResponse,
} from "./apiSchemas.ts";

/** SSE comment sent periodically so proxies and browsers keep the stream open through quiet
 *  stretches (a run whose method phase has not started yet emits nothing for a while). */
const SSE_KEEPALIVE_MS = 15000;

/** `POST /api/runs/scenario`: a scenario document, or the id of one already in the library. */
export interface StartScenarioRunRequest extends Omit<CreateRunRequest, "timeline"> {
  /** A scenario file's contents — either shape `parseScenarioDocument` accepts. */
  scenario?: unknown;
  /** A file stem in the scenario library, as listed by `GET /api/scenarios`. */
  scenarioId?: string;
}

function statusForError(error: unknown): number {
  if (error instanceof TimelineValidationError) return 422;
  // A scenario document that does not parse is bad input in the same sense, and carries the same
  // per-path issue list.
  if (error instanceof ScenarioFileError) return 422;
  if (error instanceof InvalidTargetError || error instanceof EmptyPlanError) return 400;
  // The target's corpus for an entity an explicit `idPool.source: "server"` request needs came
  // back empty — a compile-time discovery, not a server or plan error, but still "you cannot run
  // this against this target as authored".
  if (error instanceof EmptyServerCorpusError) return 400;
  if (error instanceof RunNotFoundError || error instanceof ScenarioNotFoundError) return 404;
  if (error instanceof EngineUnavailableError) return 503;
  return 500;
}

function errorBody(error: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { error: (error as Error).message ?? "Unknown error" };
  // Validation failures carry the full issue list with paths, which is what lets the editor point
  // at the offending line rather than just saying "invalid". A document that failed before any
  // rule could run (unparseable JSON, say) has none, and an empty array reads as "no problems".
  const issues = error instanceof TimelineValidationError || error instanceof ScenarioFileError ? error.issues : [];
  if (issues.length > 0) body.issues = issues;
  return body;
}

/** Stands in for the filename `parseScenarioDocument` reports against, for a document that
 *  arrived over the wire and so has none. A document carrying its own `name` keeps it; this is
 *  only the fallback, and what the resulting error messages are phrased around. */
const UPLOADED_FILENAME = "uploaded-scenario.json";

/**
 * Resolves the two ways of naming a scenario down to the one thing the run pipeline takes: a
 * timeline. Both paths go through `parseScenarioDocument` (directly, or via the library), so a
 * document this endpoint runs is exactly a document the Load screen would open.
 *
 * Assumes the caller has already established that exactly one of the two is present.
 */
async function resolveScenario(body: StartScenarioRunRequest): Promise<{ timeline: LoadTimelineData; name: string }> {
  if (typeof body.scenarioId === "string" && body.scenarioId.trim() !== "") {
    const data = await readScenario(body.scenarioId.trim());
    return { timeline: data.phases.method, name: data.name };
  }
  const scenario = scenarioFromParsed(body.scenario, UPLOADED_FILENAME);
  return { timeline: scenario.phases.method.toJSON(), name: scenario.name };
}

const runRequestProperties = {
  target: { $ref: "#/components/schemas/RunTarget" },
  scenarioName: { type: "string", description: "Labels the run. Defaults to the scenario's own name, or \"Untitled\"." },
  connectionId: { type: "string", description: "Recorded on the run so results can be attributed to a target later." },
  engineId: { type: "string", enum: ["k6"], description: "Names an adapter. Only k6 is implemented (ADR 0001)." },
  dryRun: {
    type: "boolean",
    description: "Validate and compile, create the run, and stop there — status `compiled`, not a single request sent. The generated scripts are still readable from `/artifacts/main.js` and the files it lists.",
  },
} as const;

const runViewResponse = (description: string) => ({ description, $ref: "#/components/schemas/RunView" });

export function registerRunRoutes(
  app: FastifyInstance,
  deps: { runs: RunService; engines: EngineRegistry; archive: K6RunArchive },
): void {
  const { runs, engines, archive } = deps;

  /** Which engines this build can actually run, and their versions. */
  app.get(
    "/api/engines",
    documented({
      tags: ["engines"],
      summary: "List engine adapters and whether they are installed",
      description:
        "k6 runs as an external subprocess, so it can be absent on a machine that otherwise works. Ask this first: a missing binary is a setup problem, not a benchmark result.",
      response: {
        200: {
          description: "Every registered adapter, with the version of the binary found on PATH.",
          type: "object",
          properties: {
            engines: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  available: { type: "boolean" },
                  version: { type: "string" },
                  detail: { type: "string" },
                },
              },
            },
          },
        },
      },
    }),
    async () => {
      const adapters = engines.list();
      const availability = await Promise.all(
        adapters.map(async (adapter) => ({
          id: adapter.id,
          name: adapter.name,
          ...(await adapter.probe()),
        })),
      );
      return { engines: availability };
    },
  );

  /**
   * Compiles a timeline and returns the plan plus the generated engine script, without executing
   * anything and without creating a run.
   */
  app.post<{ Body: CreateRunRequest }>(
    "/api/runs/compile",
    documented({
      tags: ["runs"],
      summary: "Compile a timeline without running it",
      description:
        "Returns the k6 plan and every generated file — `main.js` plus one small script per request type of each load — so the translation from timeline to IDTA-01002 calls is inspectable before anything is sent. Creates no run, but does contact the target if the plan addresses an existing entity: identifiers are resolved (paged in, or minted for creates) at compile time rather than by the scripts themselves, so this preview and the run it precedes see the same target state. An explicit `idPool.source: \"server\"` request whose entity harvests to nothing fails the compile with 400. Target header *values* are redacted from the plan — the scripts read them from the `KAIGARA_HEADERS` environment variable at run time.",
      body: {
        type: "object",
        required: ["timeline", "target"],
        properties: { timeline: { $ref: LOAD_TIMELINE_REF }, ...runRequestProperties },
        example: { timeline: EXAMPLE_TIMELINE, target: EXAMPLE_TARGET },
      },
      response: {
        200: {
          description: "The plan, the generated files, and any non-blocking warnings found in the timeline.",
          type: "object",
          properties: {
            plan: { type: "object", additionalProperties: true },
            files: {
              type: "array",
              description: "`main.js` first, then one standalone script per request type, in the order k6 starts them.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", examples: ["main.js", "k6_writes_steady_create_submodel.js"] },
                  content: { type: "string", description: "The file, verbatim." },
                },
              },
            },
            warnings: { type: "array", items: { $ref: "#/components/schemas/ValidationIssue" } },
          },
        },
        400: errorResponse("The target is unusable, or the timeline compiles to nothing."),
        422: errorResponse("The timeline is invalid; `issues` lists every offending path."),
      },
    }),
    async (request, reply) => {
      try {
        const { plan, files, warnings } = await runs.compileOnly(request.body);
        return { plan, files, warnings };
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  /**
   * Expands a timeline into a per-load request schedule — the "concrete" plan. Compiles the same
   * way `/compile` does, then reads each load's executor and expected-request total into "this
   * load runs on executor X and issues ~N of these IDTA-01002 calls". Creates no run and sends
   * nothing.
   */
  app.post<{ Body: CreateRunRequest }>(
    "/api/runs/concrete-plan",
    documented({
      tags: ["runs"],
      summary: "Expand a timeline into a time-ordered request schedule",
      description:
        "Returns the concrete execution plan behind the Run screen's debug view: for each load, which k6 executor it runs on and roughly how many of each request it will issue. Deterministic and bucketed so a long run stays readable. Counts are expectations — the real per-request choice is randomised by weight.",
      body: {
        type: "object",
        required: ["timeline", "target"],
        properties: { timeline: { $ref: LOAD_TIMELINE_REF }, ...runRequestProperties },
        example: { timeline: EXAMPLE_TIMELINE, target: EXAMPLE_TARGET },
      },
      response: {
        200: {
          description: "The bucketed schedule, plus any non-blocking timeline warnings.",
          type: "object",
          additionalProperties: true,
        },
        400: errorResponse("The target is unusable."),
        422: errorResponse("The timeline is invalid; `issues` lists every offending path."),
      },
    }),
    async (request, reply) => {
      try {
        return await runs.concretePlan(request.body);
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  /**
   * Accepts a serialized `LoadTimeline` and executes it.
   *
   * Body: `{ timeline, target: { baseUrl, timeoutSeconds?, headers? }, scenarioName?,
   * connectionId?, engineId?, dryRun? }`.
   */
  app.post<{ Body: CreateRunRequest }>(
    "/api/runs",
    documented({
      tags: ["runs"],
      summary: "Run a timeline",
      description:
        "Takes a serialized `LoadTimeline` — byte-for-byte what the Compose screen's Code view shows — validates it, compiles it for an engine, and executes it against the target. Returns immediately with the created run; follow it with `GET /api/runs/{id}` or the SSE stream.\n\nHolding a scenario *file* rather than a bare timeline? Use `POST /api/runs/scenario`.",
      body: {
        type: "object",
        required: ["timeline", "target"],
        properties: { timeline: { $ref: LOAD_TIMELINE_REF }, ...runRequestProperties },
        example: { timeline: EXAMPLE_TIMELINE, target: EXAMPLE_TARGET, scenarioName: "Steady submodel writes" },
      },
      response: {
        201: runViewResponse("The run, as created — `starting` or `running`, or `compiled` for a dry run."),
        400: errorResponse("Malformed body, an unusable target, or a timeline that compiles to nothing."),
        422: errorResponse("The timeline is invalid; `issues` lists every offending path."),
        503: errorResponse("The requested engine is not installed on this machine."),
      },
    }),
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || body.timeline === undefined) {
        return reply
          .code(400)
          .send({ error: "Body must be { timeline, target: { baseUrl }, … }. See backend/README.md." });
      }
      try {
        const view = await runs.create(body);
        return reply.code(201).send(view);
      } catch (error) {
        request.log.warn({ err: error }, "run creation failed");
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  /**
   * The same execution path as `POST /api/runs`, entered with a scenario document.
   *
   * A convenience wrapper, not a second pipeline: it resolves the document to its method timeline
   * and hands that to the same `RunService.create`. It exists because the unit a user *has* is a
   * file — one they wrote, or one already sitting in the library — and requiring them to first dig
   * `phases.method` out of it by hand is friction with no purpose.
   */
  app.post<{ Body: StartScenarioRunRequest }>(
    "/api/runs/scenario",
    documented({
      tags: ["runs"],
      summary: "Run a scenario document, or one from the library",
      description:
        [
          "Give it exactly one of:",
          "",
          "- `scenario` — the contents of a scenario file. Both shapes the Load screen accepts work: a full scenario object, or a bare timeline.",
          "- `scenarioId` — a file stem from `GET /api/scenarios`, e.g. `shape-showcase`.",
          "",
          "To send a file you have on disk:",
          "",
          "```",
          "curl -sX POST http://127.0.0.1:5174/api/runs/scenario -H 'content-type: application/json' \\",
          `  -d "$(jq '{scenario: ., target: {baseUrl: \"http://127.0.0.1:8081/api/v3\"}}' my-scenario.json)"`,
          "```",
          "",
          "Add `\"dryRun\": true` to compile and inspect the plan without sending a single request.",
          "",
          "Only the `method` phase runs: preparation, pre/postconditions and cleanup are not implemented and are reported as `skipped` rather than `done`, so a clean run is never mistaken for \"correctness checks passed\".",
        ].join("\n"),
      body: {
        type: "object",
        required: ["target"],
        properties: {
          scenario: { $ref: "#/components/schemas/ScenarioDocument" },
          scenarioId: { type: "string", description: "A file stem from `GET /api/scenarios`, e.g. `shape-showcase`." },
          ...runRequestProperties,
        },
        example: { scenarioId: "shape-showcase", target: EXAMPLE_TARGET, dryRun: true },
      },
      response: {
        201: runViewResponse("The run, as created — `starting` or `running`, or `compiled` for a dry run."),
        400: errorResponse("Neither or both of `scenario` and `scenarioId`, an unusable target, or a scenario that compiles to nothing."),
        404: errorResponse("No scenario with that id in the library."),
        422: errorResponse("The document is not a usable scenario; `issues` lists every offending path."),
        503: errorResponse("The requested engine is not installed on this machine."),
      },
    }),
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "Body must be { scenario | scenarioId, target: { baseUrl }, … }." });
      }
      // Neither, or both: a malformed request rather than an unusable scenario, so 400 and no
      // issue list — there is no document yet to have issues with.
      const hasInline = body.scenario !== undefined && body.scenario !== null;
      const hasId = typeof body.scenarioId === "string" && body.scenarioId.trim() !== "";
      if (hasInline === hasId) {
        return reply.code(400).send({
          error:
            'Body must carry exactly one of "scenario" (a scenario document) or "scenarioId" (a file stem from GET /api/scenarios).',
        });
      }
      try {
        const { timeline, name } = await resolveScenario(body);
        const view = await runs.create({ ...body, timeline, scenarioName: body.scenarioName ?? name });
        return reply.code(201).send(view);
      } catch (error) {
        request.log.warn({ err: error }, "scenario run creation failed");
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  app.get(
    "/api/runs",
    documented({
      tags: ["runs"],
      summary: "List runs, newest first",
      description:
        "Runs are held in memory: this is empty after a restart. SQLite-backed history is the next step (proposal §10) — until then, `GET /api/runs/archive` covers reopening a run from an earlier backend process, via the k6 adapter's own on-disk archive rather than a database.",
      response: {
        200: {
          description: "Every run this process still holds.",
          type: "object",
          properties: { runs: { type: "array", items: { $ref: "#/components/schemas/RunView" } } },
        },
      },
    }),
    async () => ({ runs: runs.list() }),
  );

  const archiveEntrySchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "Opaque — pass verbatim to GET /api/runs/archive/{id}." },
      runId: { type: "string" },
      scenarioName: { type: "string" },
      targetBaseUrl: { type: "string" },
      engineId: { type: "string" },
      calledAt: { type: "string", format: "date-time" },
      startEpochMs: { type: "number" },
      status: { type: "string", description: "A RunLifecycleStatus, once the run has one." },
      endedAt: { type: "string", format: "date-time" },
      requests: { type: "number" },
      failed: { type: "number" },
    },
  } as const;

  /**
   * "Open previous execution": every archived run this backend (across every restart) still has a
   * `manifest.json` for — the k6 adapter's own persistent archive (`runArchive.ts`), not the
   * in-memory `RunService` state `GET /api/runs` reads. This is what survives a backend restart.
   */
  app.get(
    "/api/runs/archive",
    documented({
      tags: ["runs"],
      summary: "List archived runs, newest first",
      description:
        "Reads the k6 adapter's on-disk archive (default `./k6-logs`), across every backend session it has ever written — this is what a restarted backend can still offer for \"open previous execution\", unlike `GET /api/runs` (in-memory only).",
      response: {
        200: {
          description: "Every archived run this backend can find.",
          type: "object",
          properties: { entries: { type: "array", items: archiveEntrySchema } },
        },
      },
    }),
    async () => ({ entries: await archive.list() }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/runs/archive/:id",
    documented({
      tags: ["runs"],
      summary: "Reopen one archived run",
      description:
        "The manifest always; the authored timeline whenever its file is present (`null` for an archive from before this feature existed, or a run that never got past compiling). `requestLog` is always `null` here — reopening a run must not by itself parse and transfer its whole log; fetch a Load's log lazily instead, from GET /api/runs/{manifest.runId}/requests?loadId=, which works for an archived run too.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "An `id` from GET /api/runs/archive." } },
      },
      response: {
        200: {
          description: "The reconstructed run.",
          type: "object",
          required: ["manifest", "timeline", "plan", "requestLog"],
          properties: {
            manifest: archiveEntrySchema,
            timeline: { $ref: LOAD_TIMELINE_REF, nullable: true },
            plan: {
              type: "object",
              nullable: true,
              description: "The same shape as a live run's RunView.plan — read from the archived plan.json.",
              additionalProperties: true,
            },
            requestLog: {
              type: "object",
              nullable: true,
              properties: {
                samples: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      offsetMs: { type: "number" },
                      loadKey: { type: "string" },
                      operation: { type: "string" },
                      target: { type: "string" },
                      durationMs: { type: "number" },
                      status: { type: "number" },
                      failed: { type: "boolean" },
                      exchangeId: { type: "string" },
                    },
                  },
                },
                truncated: { type: "boolean" },
              },
            },
          },
        },
        404: errorResponse("No archived run with that id."),
      },
    }),
    async (request, reply) => {
      const found = await archive.read(request.params.id);
      if (!found) return reply.code(404).send({ error: `No archived run with id "${request.params.id}".` });
      return found;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/runs/:id",
    documented({
      tags: ["runs"],
      summary: "One run",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      response: { 200: runViewResponse("The run as it stands now."), 404: errorResponse("No run with that id.") },
    }),
    async (request, reply) => {
      try {
        return runs.get(request.params.id);
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/stop",
    documented({
      tags: ["runs"],
      summary: "Stop a run gracefully",
      description: "SIGINT: in-flight iterations finish and the summary is still written, so a stopped run still carries usable numbers.",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      response: { 200: runViewResponse("The run, now `stopped`."), 404: errorResponse("No run with that id.") },
    }),
    async (request, reply) => {
      try {
        return await runs.stop(request.params.id);
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  /**
   * One Load's complete per-request log — every request that Load produced, not the bounded live
   * tail `RunView.metrics.recentSamples` carries. Deliberately its own endpoint rather than a field
   * on `RunView`: that keeps its cost off the SSE stream's 1-second cadence entirely (see
   * `metricsAggregator.ts`'s own doc comment). Deliberately scoped to `?loadId=` too, rather than
   * the whole run: a finished run can carry hundreds of thousands of samples, and the Run screen
   * only ever renders one Load's log at a time — omitting `loadId` returns an empty `samples` array
   * rather than everything, so opening a run never pays to transfer data no panel shows.
   *
   * Works for a still-running run (served from the in-memory `RunService`) and an archived one
   * (served from `metrics.ndjson` on disk) alike, exactly the way `GET /api/runs/{id}/exchanges/
   * {exchangeId}` already does — `id` is always the bare runId, never an archive id.
   */
  app.get<{ Params: { id: string }; Querystring: { loadId?: string } }>(
    "/api/runs/:id/requests",
    documented({
      tags: ["runs"],
      summary: "One Load's complete per-request log",
      description:
        "Every request recorded for this run's `loadId`, oldest first — empty if `loadId` is omitted. Not part of the live SSE stream on purpose — fetch this once a Load is selected, normally only after the run reaches a terminal status (`live: false` in the response says so either way). Works for an archived run too, by its `runId` (from `GET /api/runs/archive/{id}`'s `manifest.runId`), not just a live one.",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      querystring: {
        type: "object",
        properties: { loadId: { type: "string", description: "A RunPlanLoadSummary.loadId — one Load can compile to several loadKeys (ADR 0005), all included." } },
      },
      response: {
        200: {
          description: "The request log for this Load so far.",
          type: "object",
          required: ["samples", "truncated", "live"],
          properties: {
            samples: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  offsetMs: { type: "number" },
                  loadKey: { type: "string" },
                  operation: { type: "string" },
                  target: { type: "string" },
                  durationMs: { type: "number" },
                  status: { type: "number" },
                  failed: { type: "boolean" },
                  exchangeId: { type: "string", description: "Pass to GET /api/runs/{id}/exchanges/{exchangeId} for this row's full request/response." },
                  requestTruncated: { type: "boolean", description: "Whether the captured request body was cut at 64 KB. Absent when exchangeId is absent." },
                  responseTruncated: { type: "boolean", description: "Whether the captured response body was cut at 64 KB. Absent when exchangeId is absent." },
                },
              },
            },
            truncated: { type: "boolean", description: "True only if the safety cap on the log was actually reached." },
            live: { type: "boolean", description: "True while the run has not reached a terminal status yet." },
          },
        },
        404: errorResponse("No run with that id — live or archived."),
      },
    }),
    async (request, reply) => {
      const { id } = request.params;
      const { loadId } = request.query;
      try {
        if (runs.has(id)) {
          const log = runs.fullRequestLog(id, loadId);
          log.samples = await archive.enrichTruncation(id, log.samples);
          return log;
        }
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
      const archived = await archive.requestLog(id, loadId);
      if (!archived) return reply.code(404).send({ error: `No run with id "${id}".` });
      return { ...archived, live: false };
    },
  );

  /**
   * The Run screen's "open this row" popup: the literal request and response the k6 script
   * captured for one sample's `exchangeId`, read from the run's `exchanges.log`. Works the same for
   * a still-running run (k6 is still appending to it) and an archived one — see
   * `K6RunArchive.exchange()`.
   */
  app.get<{ Params: { id: string; exchangeId: string } }>(
    "/api/runs/:id/exchanges/:exchangeId",
    documented({
      tags: ["runs"],
      summary: "One captured request/response exchange",
      description:
        "The literal request and response for one row of the request log, read from the run's log folder (`exchanges.log`, which k6 writes itself while the run is live). How much of each body was kept follows the timeline's `capture` setting — cut at 64 KB, a sample kept complete, or everything complete, with errors optionally always complete. `requestBytes`/`responseBytes` are the real sizes either way.",
      params: {
        type: "object",
        required: ["id", "exchangeId"],
        properties: {
          id: { type: "string", description: "The run's id (RunView.id) — live or archived." },
          exchangeId: { type: "string", description: "A sample's exchangeId, from GET /api/runs/{id}/requests or an archived run's requestLog." },
        },
      },
      response: {
        200: {
          description: "The captured exchange.",
          type: "object",
          properties: {
            id: { type: "string" },
            method: { type: "string" },
            url: { type: "string" },
            requestBody: { type: "string" },
            requestTruncated: { type: "boolean" },
            requestBytes: { type: "number", description: "UTF-8 size of the request body as sent, whether or not it was cut." },
            status: { type: "number" },
            responseBody: { type: "string" },
            responseTruncated: { type: "boolean" },
            responseBytes: { type: "number", description: "UTF-8 size of the response body as received, whether or not it was cut." },
          },
        },
        404: errorResponse("No such run, or no captured exchange with that id."),
      },
    }),
    async (request, reply) => {
      const found = await archive.exchange(request.params.id, request.params.exchangeId);
      if (!found) {
        return reply.code(404).send({ error: `No captured exchange "${request.params.exchangeId}" for run "${request.params.id}".` });
      }
      return found;
    },
  );

  /** A generated file (or the plan) for a run, so the user can read exactly what was executed. */
  app.get<{ Params: { id: string; name: string } }>(
    "/api/runs/:id/artifacts/:name",
    documented({
      tags: ["runs"],
      summary: "Read a generated artifact",
      description:
        "`main.js` — the entry point k6 was handed — one of the per-request scripts it schedules (named `k6_<track>_<load>_<request spec>.js`, e.g. `k6_writes_steady_create_submodel.js`), or `plan.json`, the k6 plan they were rendered from. Names come from the run's `artifacts` list.",
      params: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string", description: "`main.js`, one of the numbered scripts, or `plan.json`.", examples: ["main.js"] },
        },
      },
      // No response schema: the body is the artifact's own text, sent with its own content type.
    }),
    async (request, reply) => {
      try {
        const { artifact, content } = await runs.readArtifact(request.params.id, request.params.name);
        return reply.type(artifact.contentType).send(content);
      } catch (error) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
    },
  );

  /**
   * Live run state as Server-Sent Events.
   *
   * SSE rather than a WebSocket: the stream is one-directional (control actions are ordinary POSTs),
   * it survives proxies without an upgrade handshake, and the browser reconnects on its own. The
   * proposal (section 7.2) allows either; this is the cheaper half.
   */
  app.get<{ Params: { id: string } }>(
    "/api/runs/:id/events",
    documented({
      tags: ["runs"],
      summary: "Follow a run live (Server-Sent Events)",
      description:
        "Emits a `state` event carrying a full `RunView` about once a second, then a final `end` event when the run finishes. Swagger UI cannot render a stream — read it with `curl -N` or an `EventSource`.",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      // No response schema: this route writes to the raw socket rather than replying with JSON.
    }),
    (request, reply) => {
      let unsubscribe: (() => void) | undefined;
      try {
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // The run stream is read cross-origin from the Vite dev server.
          "access-control-allow-origin": request.headers.origin ?? "*",
        });

        const send = (view: RunView): void => {
          reply.raw.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
          if (view.status !== "running" && view.status !== "starting") {
            reply.raw.write("event: end\ndata: {}\n\n");
            cleanup();
            reply.raw.end();
          }
        };

        const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);

        const cleanup = (): void => {
          clearInterval(keepalive);
          unsubscribe?.();
          unsubscribe = undefined;
        };

        unsubscribe = runs.subscribe(request.params.id, send);
        request.raw.on("close", cleanup);
      } catch (error) {
        unsubscribe?.();
        if (!reply.raw.headersSent) {
          return reply.code(statusForError(error)).send(errorBody(error));
        }
        reply.raw.end();
      }
    },
  );
}
