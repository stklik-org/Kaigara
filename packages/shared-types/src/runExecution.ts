/**
 * The wire contract for executing a timeline: what the frontend posts to `POST /api/runs`, and
 * what it gets back.
 *
 * These live in shared-types rather than in the backend so the two ends cannot drift — the same
 * reason `Connection`/`RunState`/`RunAnalysis` do. Note what is deliberately *absent*: nothing
 * here mentions k6, scripts, VUs or stages. Per ADR 0001, the engine-neutral execution plan and
 * everything below it are the backend's business; the only engine-shaped thing that crosses this
 * boundary is `engineId`, which names an adapter rather than describing one.
 */

import type { OAuth2ClientCredentials } from "./connection.ts";
import type { EngineId } from "./engine.ts";
import type { LoadTimelineData } from "./loadTimeline.ts";
import type { ValidationIssue } from "./loadTimelineValidation.ts";
import type { RequestOperation, RequestTargetEntity } from "./requestComposition.ts";
import type { RunState } from "./run.ts";

/** Where a run points. Sent explicitly rather than referenced by connection id: the backend does
 *  not own connections yet, and the caller already knows which target it picked. */
export interface RunTarget {
  /** API root of the AAS server, e.g. "http://localhost:8081/api/v3". */
  baseUrl: string;
  timeoutSeconds?: number;
  /** Applied to every generated request. */
  headers?: Record<string, string>;
  /** When set, `RunService` exchanges these for a bearer token before compiling and merges it
   *  into `headers` as `Authorization` — see `OAuth2ClientCredentials`. */
  oauth2?: OAuth2ClientCredentials;
}

export interface StartRunRequest {
  /** The composed timeline, exactly as `LoadTimeline.toJSON()` serializes it. */
  timeline: LoadTimelineData;
  target: RunTarget;
  scenarioName?: string;
  /** Recorded on the run so results can be attributed to a target later. */
  connectionId?: string;
  /** Defaults to "k6", the only adapter implemented. */
  engineId?: EngineId;
  /** Compile and validate without executing — "show me what this would do". */
  dryRun?: boolean;
}

export type RunLifecycleStatus = "compiled" | "starting" | "running" | "completed" | "failed" | "stopped";

export interface RunPlanLoadSummary {
  /** Engine-side identifier; also the metric tag results are attributed to. */
  key: string;
  loadId: string;
  trackId: string;
  label: string;
  startSeconds: number;
  requestCount: number;
}

export interface RunPlanSummary {
  totalDurationSeconds: number;
  loadCount: number;
  /** Requests the plan expects to issue if the target keeps up — the integral of every rate curve
   *  plus every fixed iteration count, i.e. the same number the Compose overlay previews. */
  expectedRequests: number;
  loads: RunPlanLoadSummary[];
}

/** One request type within a {@link ConcretePlanEntry} — a row of the debug view. */
export interface ConcretePlanRequestLine {
  /** The authored RequestSpec id this line came from. */
  requestId: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  method: string;
  /** Path relative to the target base URL. `{id}` stays a placeholder — the engine substitutes a
   *  base64url-encoded identifier from its pool at run time. Any query string is included. */
  path: string;
  /** This request's share of the load, 0..1 (the authored weights, normalised). */
  share: number;
  /** Expected requests of this kind over the whole load, if the target keeps up. */
  expectedRequests: number;
}

/**
 * One compiled load — i.e. one engine scenario. Mirrors what the k6 adapter emits (see
 * `backend/src/engines/k6/compileScript.ts`): a start time, a duration, an executor, and the rate
 * or iteration count it runs at. The load's request composition is broken out into `requests`,
 * one line per authored request type with its expected total.
 */
export interface ConcretePlanEntry {
  loadId: string;
  loadKey: string;
  loadLabel: string;
  trackLabel: string;
  shapeKind: string;
  /** Offset from the start of the run at which the engine starts this load, seconds. */
  startSeconds: number;
  /** How long the executor runs, seconds. For instantaneous shapes (spike, individual) this is the
   *  window they are spread over, not the authored 0. */
  durationSeconds: number;
  /** The k6 executor this load compiles to — the only engine implemented (ADR 0001). */
  executor: "constant-arrival-rate" | "ramping-arrival-rate" | "shared-iterations";
  /** Human-readable rate profile, e.g. "constant 100 req/s", "ramp 380 → 0 req/s", "50 iterations". */
  rateSummary: string;
  /** Peak arrival rate, req/s. Absent for `shared-iterations`, which has a count, not a rate. */
  peakRatePerSec?: number;
  /** Total expected requests from this load across every request type. */
  expectedRequests: number;
  requests: ConcretePlanRequestLine[];
}

/**
 * The execution plan as a load-tool debug view: one entry per compiled load (engine scenario),
 * saying when the engine starts it, for how long, at what rate, and which IDTA-01002 calls it
 * issues. Returned by `POST /api/runs/concrete-plan`; nothing is executed to produce it.
 *
 * Request totals are expectations — the engine picks each request with a weighted random draw, so
 * the real per-request sequence varies run to run.
 */
export interface ConcretePlan {
  scenarioName: string;
  targetBaseUrl: string;
  totalDurationSeconds: number;
  /** Total the plan expects to issue if the target keeps up — the same number the Compose overlay
   *  previews and `RunPlanSummary.expectedRequests` reports. */
  expectedRequests: number;
  entries: ConcretePlanEntry[];
  /** Non-blocking issues found in the source timeline. */
  warnings: ValidationIssue[];
}

export interface RunRequestTotals {
  requests: number;
  failed: number;
  durationMsSum: number;
}

/** One raw per-request event — the shape both `RunMetrics.recentSamples` (the live tail) and
 *  `GET /api/runs/:id/requests` (the complete log, fetched once a run is done) carry. Mirrors the
 *  engine-neutral shape `backend/src/engines/adapter.ts`'s `RequestSample` already uses
 *  internally. */
export interface RunRequestSample {
  /** Milliseconds since the run started. */
  offsetMs: number;
  /** The compiled load this request belongs to — matches a `RunPlanLoadSummary.key`. */
  loadKey: string;
  operation: string;
  target: string;
  durationMs: number;
  /** HTTP status, or 0 when the request never completed (timeout, connection refused). */
  status: number;
  failed: boolean;
  /** Pass to `GET /api/runs/:id/exchanges/:exchangeId` for this row's captured request and
   *  response — see `RunExchange`. `undefined` for a sample the engine never captured one for
   *  (an archive from before this existed, or an adapter that does not capture exchanges). */
  exchangeId?: string;
  /** Whether this row's captured request/response body was cut at `EXCHANGE_CAPTURE_CAP` rather
   *  than kept whole — read cheaply from `exchanges.log`'s own index (`exchangeLog.ts`), never by
   *  loading the body. Both `undefined` when `exchangeId` is `undefined` (nothing was captured for
   *  this request), or when the exchange line has not been indexed yet. */
  requestTruncated?: boolean;
  responseTruncated?: boolean;
}

/** `GET /api/runs/:id/exchanges/:exchangeId` — the "open this row" popup's whole content: the
 *  literal request and response for one captured exchange, read back from the run's log folder on
 *  demand rather than carried by every sample. How much of each body was kept follows the
 *  timeline's `capture` setting (`ExchangeCaptureData`); `*Truncated` says whether this one was
 *  cut, and `*Bytes` is the real UTF-8 size of the body as sent or received, cut or not. */
export interface RunExchange {
  id: string;
  method: string;
  url: string;
  requestBody: string;
  requestTruncated: boolean;
  requestBytes: number;
  status: number;
  responseBody: string;
  responseTruncated: boolean;
  responseBytes: number;
}

/** `GET /api/runs/:id/requests?loadId=` — the complete per-request log for one Load, not the live
 *  `recentSamples` tail. Deliberately not part of `RunView`/the SSE stream: serializing every
 *  request on a 1-second timer would grow with run length exactly the way `proposal §7.2` warned
 *  about. It is also deliberately scoped to one `loadId` rather than the whole run: a finished run
 *  can carry hundreds of thousands of samples across every Load, and the Run screen only ever
 *  renders one Load's log at a time (`RequestResponseView`) — omitting `loadId` returns an empty
 *  `samples` array (`truncated`/`live` still reflect the whole run), so the client never pays for
 *  data no panel is showing. */
export interface RunRequestLog {
  samples: RunRequestSample[];
  /** True if `FULL_LOG_SAFETY_CAP` (`metricsAggregator.ts`) was reached and the oldest requests
   *  were dropped to stay within it — practically never, for a run of any ordinary size. */
  truncated: boolean;
  /** True while the run has not reached a terminal status yet — this is "so far", not the whole
   *  run. The Run screen only fetches this endpoint once `live` would be false. */
  live: boolean;
}

/** Server-side aggregates. `recentSamples` is the one raw-event field re-published on every live
 *  tick — bounded so its cost never grows with run length (see `metricsAggregator.ts`'s own doc
 *  comment); the complete log lives at `GET /api/runs/:id/requests` instead. Everything else here
 *  stays a rolling aggregate. */
export interface RunMetrics {
  requests: number;
  failed: number;
  meanDurationMs: number;
  percentiles: { p50: number; p95: number; p99: number; max: number };
  byLoad: Record<string, RunRequestTotals>;
  /** Keyed "operation:target", e.g. "create:submodel". */
  byOperation: Record<string, RunRequestTotals>;
  byStatus: Record<string, number>;
  activeLoadKeys: string[];
  /** The most recent requests, oldest first, capped server-side — the Run screen's *live* log.
   *  Not the complete run: a sustained high-throughput run will have long since dropped its
   *  earliest ones out of this window even though the aggregates above still count them. Fetch
   *  `GET /api/runs/:id/requests` (`RunRequestLog`) for the complete record. */
  recentSamples: RunRequestSample[];
}

/** The engine's own end-of-run totals, kept alongside `RunMetrics` rather than merged into it. */
export interface EngineRunSummary {
  /**
   * Every HTTP request the engine issued — **including** the handful Kaigara makes on its own
   * behalf to seed its identifier pool. It is therefore normally a little higher than
   * `RunMetrics.requests`, which counts only requests attributable to an authored load. The gap is
   * intentional: report `RunMetrics.requests` as the workload, and use this to reconcile against
   * what the engine believes it did.
   */
  requests: number;
  failed: number;
  durationMs?: { avg?: number; p95?: number; p99?: number; max?: number };
  /** Requests the engine wanted to start but could not, because its own worker pool was
   *  saturated. Non-zero means the *tool* was the bottleneck rather than the server under test,
   *  which invalidates the measurement — surface it, never bury it. */
  droppedIterations?: number;
}

export interface RunArtifactRef {
  name: string;
  description: string;
  contentType: string;
}

/** `GET /api/runs/archive` / `GET /api/runs/archive/:id` — "open previous execution", reading the
 *  k6 adapter's own on-disk archive (`backend/src/engines/k6/runArchive.ts`) rather than
 *  `RunService`'s in-memory state, so it survives a backend restart the way `GET /api/runs` does
 *  not. Deliberately its own small surface, not `RunView` reused: an archived run has no live
 *  state, no engine handle, nothing to subscribe to — only what was written to disk. */
export interface RunArchiveManifest {
  runId: string;
  scenarioName: string;
  targetBaseUrl: string;
  engineId: EngineId;
  /** ISO-8601. */
  calledAt: string;
  /** Absent for a run that only ever compiled and never actually started. */
  startEpochMs?: number;
  /** A `RunLifecycleStatus`'s terminal value, once the run has one. */
  status?: string;
  endedAt?: string;
  requests?: number;
  failed?: number;
}

/** One row of `GET /api/runs/archive`. */
export interface RunArchiveEntry extends RunArchiveManifest {
  /** Opaque — pass verbatim to `GET /api/runs/archive/:id`. */
  id: string;
}

/** `GET /api/runs/archive/:id`'s body. `timeline`/`plan` are `null` when their file is missing —
 *  an archive from before this existed, or a run that never got past compiling. `plan` is read
 *  from the archived (redacted) `plan.json` — it is what lets the request log's `loadKey`s resolve
 *  to human labels the same way a live `RunView.plan` does. `requestLog` is always `null` here: an
 *  archived run's log is fetched the same lazy, per-`loadId` way a live one's is, from
 *  `GET /api/runs/{manifest.runId}/requests?loadId=` (which works for an archived run too, reading
 *  `metrics.ndjson` from disk instead of the in-memory aggregator) — reopening a run must not by
 *  itself re-parse and transfer its entire log. */
export interface RunArchiveDetail {
  manifest: RunArchiveManifest;
  timeline: LoadTimelineData | null;
  plan: RunPlanSummary | null;
  requestLog: { samples: RunRequestSample[]; truncated: boolean } | null;
}

/** Everything known about one run. Fetched from `GET /api/runs/:id` and pushed over the SSE
 *  stream at `GET /api/runs/:id/events`. */
export interface RunView {
  id: string;
  status: RunLifecycleStatus;
  scenarioName: string;
  connectionId: string;
  engineId: EngineId;
  targetBaseUrl: string;
  createdAt: string;
  endedAt?: string;
  /** Projection onto the shape the Run screen already renders. */
  state: RunState;
  plan: RunPlanSummary;
  metrics: RunMetrics;
  /** Non-blocking issues found in the source timeline — why a run may not do what was expected. */
  warnings: ValidationIssue[];
  engineSummary?: EngineRunSummary;
  /** Generated inputs (the engine script, the plan) readable via
   *  `GET /api/runs/:id/artifacts/:name`, so the timeline-to-requests translation is inspectable. */
  artifacts: RunArtifactRef[];
  engineLog: string[];
  error?: string;
}

export interface EngineDescriptorView {
  id: EngineId;
  name: string;
  available: boolean;
  version?: string;
  detail: string;
}
