/**
 * The `EngineAdapter` seam required by ADR 0001.
 *
 * The proposal's Option C (section 5.3) is the target end-state: k6, autocannon, Gatling or a
 * future in-house engine each registered as an adapter, with the recipe format, the HTTP API and
 * the results schema unchanged. The ADR is explicit that this interface must exist *before or
 * alongside* the first adapter rather than be retrofitted — so it is defined here, and the k6
 * adapter under `k6/` is written against it like any later one would be.
 *
 * Per ADR 0004, an adapter is handed the **authored timeline** and compiles it itself — there is
 * no shared "execution plan" type crossing this boundary. `RunService` no longer builds one and
 * hands it to an adapter; it validates nothing beyond `EngineRunContext`'s own shape and lets
 * `compile()` fail loudly (`TimelineValidationError` and friends) if the timeline is not usable.
 * What an adapter hands *back* from `compile()` — `CompiledRun` — is a deliberately thin summary
 * (identifiers, counts, a per-load key/label list), not a re-creation of that removed type: enough
 * for `RunService` to project a `RunView` and correlate live metrics to loads, nothing about
 * scripts, executors or HTTP mapping. That detail stays entirely inside the adapter that produced
 * it — even the Run screen's "concrete plan" debug view and the `plan.json` artifact are k6's own
 * translation now (`engines/k6/concretePlan.ts`), read directly by `RunService`, never exposed
 * through this interface.
 */

import type { EngineId, LoadTimelineData, ValidationIssue } from "@kaigara/shared-types";

/** Whether the engine can actually run on this machine, answered before a run is accepted so the
 *  user gets "k6 is not installed" rather than a failed run. */
export interface EngineAvailability {
  available: boolean;
  /** Engine version string as reported by the engine itself, when available. */
  version?: string;
  /** Human-readable explanation, shown in the UI when `available` is false. */
  detail: string;
}

/**
 * One completed HTTP request, normalised across engines.
 *
 * Emitted in batches rather than individually: at a few hundred requests per second the per-call
 * overhead of a finer-grained channel would itself compete with the load being generated, which
 * the minimal-footprint goal (proposal section 2.3) rules out.
 */
export interface RequestSample {
  /** Milliseconds since the run started, as observed by the engine. */
  offsetMs: number;
  /** The `key` an adapter's own `CompiledRunSummary` gave this load. */
  loadKey: string;
  operation: string;
  target: string;
  /** Server-side round trip in milliseconds. */
  durationMs: number;
  /** HTTP status, or 0 when the request never completed (timeout, connection refused). */
  status: number;
  failed: boolean;
  /** Correlates this sample with a captured request/response pair, if the adapter captures those
   *  (the k6 adapter does — see `scriptTemplates.ts`'s `EXCHANGE_LOG_PREFIX`). `undefined` for an
   *  adapter, or an older archived run, that never emitted one. */
  exchangeId?: string;
  /** Whether the captured request/response body was cut at the engine's capture cap — filled in
   *  from `exchanges.log`'s own index (`exchangeLog.ts`) after the fact, never present straight off
   *  the engine's own metrics stream (see `K6RunArchive.enrichTruncation`). */
  requestTruncated?: boolean;
  responseTruncated?: boolean;
}

export interface EngineLogLine {
  stream: "stdout" | "stderr";
  message: string;
}

/** Terminal outcome of an engine process. */
export interface EngineExit {
  /** Process exit code, or null if it was killed by a signal. */
  code: number | null;
  signal: string | null;
  /** True when the engine finished the plan; false when it crashed, was stopped, or refused the
   *  plan. Note a non-zero exit is normal for engines that fail a threshold, so adapters decide
   *  this rather than the caller inferring it from `code`. */
  completed: boolean;
  /** Populated when the engine reports totals of its own; used to reconcile the streamed samples
   *  against the engine's authoritative count. */
  summary?: EngineSummary;
}

export interface EngineSummary {
  requests: number;
  failed: number;
  durationMs?: { avg?: number; p95?: number; p99?: number; max?: number };
  /** Iterations the engine wanted to start but could not, because its worker pool was saturated.
   *  A non-zero value means the *tool* was the bottleneck, not the server under test — critical
   *  to surface, since it silently invalidates the measurement. */
  droppedIterations?: number;
}

export interface EngineHandlers {
  onSamples(samples: RequestSample[]): void;
  onLog(line: EngineLogLine): void;
  onExit(exit: EngineExit): void;
}

/** A target AAS server, resolved and normalised (`RunService.resolveTarget`) — a trimmed,
 *  scheme-checked `baseUrl`, a defaulted `timeoutSeconds`, and whatever `headers` the connection
 *  carries. Every adapter needs exactly this; nothing here is k6-specific. */
export interface ResolvedTarget {
  baseUrl: string;
  timeoutSeconds: number;
  headers: Record<string, string>;
}

export interface EngineRunContext {
  runId: string;
  /** The authored timeline, byte-for-byte what the Compose screen's Code view shows. An adapter
   *  compiles this itself — see the module doc. */
  timeline: LoadTimelineData;
  target: ResolvedTarget;
  scenarioName?: string;
  /** Directory the adapter owns for this run: generated inputs, raw engine output, artifacts.
   *  Already created by the caller. */
  workDir: string;
}

/** Files the adapter produced for a run, surfaced so the UI can show the user exactly what was
 *  executed on their behalf — the translation from timeline to requests should be inspectable,
 *  not a black box. */
export interface CompiledArtifact {
  /** Short name, e.g. "main.js". */
  name: string;
  absolutePath: string;
  /** MIME-ish hint for rendering, e.g. "application/javascript". */
  contentType: string;
  description: string;
}

/** One load's worth of facts `RunService` needs without knowing anything about how the adapter
 *  arrived at them — enough to project a `RunView` and correlate live `RequestSample.loadKey`s
 *  back to the timeline's own `Load`/`Track` ids. */
export interface CompiledLoadSummary {
  /** Stable, adapter-chosen key — what `RequestSample.loadKey` and live metrics are tagged with. */
  key: string;
  loadId: string;
  trackId: string;
  label: string;
  startSeconds: number;
  requestCount: number;
}

/** What compiling a timeline produced, independent of the engine that did it. */
export interface CompiledRunSummary {
  /** Defaulted/trimmed scenario name — never blank, unlike the request field it came from. */
  scenarioName: string;
  totalDurationSeconds: number;
  /** Requests the compiled run expects to issue if the target keeps up — the same number the
   *  Compose overlay previews. */
  expectedRequests: number;
  loads: CompiledLoadSummary[];
}

export interface CompiledRun {
  artifacts: CompiledArtifact[];
  /** Non-blocking issues found while compiling (a load that sends nothing, one scheduled past the
   *  end of the timeline) — forwarded so the caller can show the user why a run may not do what
   *  they expect. */
  warnings: ValidationIssue[];
  summary: CompiledRunSummary;
}

export interface EngineRunHandle {
  /** Asks the engine to stop; resolves once it has exited. Idempotent. */
  stop(): Promise<void>;
}

export interface EngineAdapter {
  readonly id: EngineId;
  readonly name: string;

  /** Is the engine installed and runnable here? */
  probe(): Promise<EngineAvailability>;

  /**
   * Validates and compiles `context.timeline` into whatever inputs the engine needs, under
   * `context.workDir`. Separated from `start` so a plan can be compiled and inspected (or
   * validated) without being executed — the dry-run path behind `POST /api/runs { dryRun: true }`.
   *
   * Throws (`TimelineValidationError` and whatever else is specific to this engine) rather than
   * returning a result the caller has to inspect for failure — a plan that could not be built is
   * not a `CompiledRun` with nothing in it.
   */
  compile(context: EngineRunContext): Promise<CompiledRun>;

  /** Launches the engine against a previously compiled run. */
  start(context: EngineRunContext, compiled: CompiledRun, handlers: EngineHandlers): Promise<EngineRunHandle>;
}

/** Adapters available to this build. Only k6 is implemented; ADR 0001 says not to add others
 *  speculatively, so this map stays a one-entry registry until a second engine is actually
 *  needed. */
export class EngineRegistry {
  private readonly adapters = new Map<EngineId, EngineAdapter>();

  register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: EngineId): EngineAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`No engine adapter registered for "${id}".`);
    return adapter;
  }

  list(): EngineAdapter[] {
    return [...this.adapters.values()];
  }
}
