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

import type { EngineId } from "./engine.ts";
import type { LoadTimelineData } from "./loadTimeline.ts";
import type { ValidationIssue } from "./loadTimelineValidation.ts";
import type { RunState } from "./run.ts";

/** Where a run points. Sent explicitly rather than referenced by connection id: the backend does
 *  not own connections yet, and the caller already knows which target it picked. */
export interface RunTarget {
  /** API root of the AAS server, e.g. "http://localhost:8081/api/v3". */
  baseUrl: string;
  timeoutSeconds?: number;
  /** Applied to every generated request; where authentication will go once it exists. */
  headers?: Record<string, string>;
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

export interface RunRequestTotals {
  requests: number;
  failed: number;
  durationMsSum: number;
}

/** Server-side aggregates. Raw per-request events never cross this boundary (proposal §7.2). */
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
