/**
 * Run orchestration: validate a timeline, compile it for an engine, execute it, and project the
 * result into the `RunState` the frontend already knows how to render.
 *
 * Runs live in memory only. The proposal (section 10) calls for SQLite-backed run history, and
 * that is the right next step — but persistence is orthogonal to executing a timeline, and
 * inventing a schema before there is real result data to shape it would be premature. The seam is
 * `RunStore`: swapping the Map for a database is a change here and nowhere else.
 */

import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TimelineValidationError,
  type EngineId,
  type ErrorLogEntry,
  type PhaseExecution,
  type PhaseName,
  type RunLifecycleStatus,
  type RunPlanSummary,
  type RunState,
  type RunView,
  type StartRunRequest,
  type ValidationIssue,
} from "@kaigara/shared-types";

import { compilePlan } from "../timeline/compilePlan.ts";
import type { ExecutionPlan, PlanTarget } from "../timeline/executionPlan.ts";
import { compileK6Script } from "../engines/k6/compileScript.ts";
import type {
  CompiledArtifact,
  EngineExit,
  EngineRegistry,
  EngineRunHandle,
  EngineSummary,
} from "../engines/adapter.ts";
import { MetricsAggregator, type MetricsSnapshot } from "./metricsAggregator.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
/** Seconds of req/s history handed to the live view. The Run screen's sparkline shows a window,
 *  not the whole run; the full series stays server-side. */
const LIVE_SERIES_SECONDS = 120;
const MAX_ERROR_ENTRIES = 12;
const MAX_ENGINE_LOG_LINES = 200;

// The request/response shapes are the shared wire contract (`runExecution.ts`) so the frontend and
// this module cannot drift; they are re-exported under the names the routes already use.
export type RunStatus = RunLifecycleStatus;
export type CreateRunRequest = StartRunRequest;
export type PlanSummary = RunPlanSummary;
export type { RunView };

interface RunRecord {
  id: string;
  status: RunStatus;
  scenarioName: string;
  connectionId: string;
  engineId: EngineId;
  plan: ExecutionPlan;
  workDir: string;
  createdAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  aggregator: MetricsAggregator;
  warnings: ValidationIssue[];
  artifacts: CompiledArtifact[];
  handle?: EngineRunHandle;
  engineSummary?: EngineSummary;
  engineLog: string[];
  /** Distinct failure signatures with counts, so a run that fails 40 000 times does not produce
   *  40 000 log lines. */
  errorCounts: Map<string, { count: number; firstOffsetMs: number }>;
  error?: string;
  ticker?: ReturnType<typeof setInterval>;
  subscribers: Set<(view: RunView) => void>;
}

function phase(status: PhaseExecution["status"], summary?: string): PhaseExecution {
  return summary === undefined ? { status } : { status, summary };
}

function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export class RunService {
  private readonly runs = new Map<string, RunRecord>();

  // Explicit fields rather than constructor parameter properties: Node executes this source by
  // stripping types, which cannot erase a parameter property, so `erasableSyntaxOnly` rejects one.
  private readonly engines: EngineRegistry;
  private readonly workRoot: string;

  constructor(engines: EngineRegistry, workRoot: string = join(tmpdir(), "kaigara-runs")) {
    this.engines = engines;
    this.workRoot = workRoot;
  }

  /**
   * Validates and compiles a timeline without executing it, returning the generated engine script.
   *
   * This exists so the translation from timeline to HTTP requests is inspectable rather than
   * implicit: the user can see exactly which IDTA-01002 calls their composition produces before
   * pointing it at a server.
   */
  compileOnly(request: CreateRunRequest): { plan: ExecutionPlan; script: string; warnings: ValidationIssue[] } {
    const { plan, warnings } = compilePlan(request.timeline, {
      scenarioName: request.scenarioName,
      target: this.resolveTarget(request.target),
    });
    const script = compileK6Script(plan, { summaryPath: "<run directory>/summary.json" });
    return { plan, script, warnings };
  }

  async create(request: CreateRunRequest): Promise<RunView> {
    const engineId: EngineId = request.engineId ?? "k6";
    const adapter = this.engines.get(engineId);

    // Fail before creating a run rather than producing one that dies on start — "k6 is not
    // installed" is a setup problem, not a benchmark result.
    const availability = await adapter.probe();
    if (!availability.available) {
      throw new EngineUnavailableError(`Engine "${engineId}" is not available: ${availability.detail}`);
    }

    const { plan, warnings } = compilePlan(request.timeline, {
      scenarioName: request.scenarioName,
      target: this.resolveTarget(request.target),
    });

    if (plan.loads.length === 0) {
      throw new EmptyPlanError(
        "This timeline has nothing to execute: every load either has no requests or a rate of zero.",
      );
    }

    const id = randomUUID();
    const workDir = join(this.workRoot, id);
    await mkdir(workDir, { recursive: true });

    const record: RunRecord = {
      id,
      status: "starting",
      scenarioName: plan.scenarioName,
      connectionId: request.connectionId ?? "",
      engineId,
      plan,
      workDir,
      createdAtMs: Date.now(),
      aggregator: new MetricsAggregator(),
      warnings,
      artifacts: [],
      engineLog: [],
      errorCounts: new Map(),
      subscribers: new Set(),
    };
    this.runs.set(id, record);

    record.artifacts = await adapter.compile({ runId: id, plan, workDir });

    if (request.dryRun) {
      record.status = "compiled";
      return this.view(record);
    }

    record.startedAtMs = Date.now();
    record.status = "running";

    record.handle = await adapter.start({ runId: id, plan, workDir }, record.artifacts, {
      onSamples: (samples) => {
        record.aggregator.add(samples);
        for (const sample of samples) {
          if (!sample.failed) continue;
          const key = `${sample.operation} ${sample.target} → HTTP ${sample.status || "no response"}`;
          const existing = record.errorCounts.get(key);
          if (existing) existing.count += 1;
          else record.errorCounts.set(key, { count: 1, firstOffsetMs: sample.offsetMs });
        }
      },
      onLog: (line) => {
        record.engineLog.push(line.message);
        if (record.engineLog.length > MAX_ENGINE_LOG_LINES) record.engineLog.shift();
      },
      onExit: (exit) => this.finish(record, exit),
    });

    // Elapsed time has to advance even in a second where no request completed, so it is driven by
    // the clock rather than by sample arrival.
    record.ticker = setInterval(() => this.publish(record), 1000);

    return this.view(record);
  }

  private finish(record: RunRecord, exit: EngineExit): void {
    if (record.ticker) clearInterval(record.ticker);
    record.ticker = undefined;
    record.endedAtMs = Date.now();
    record.engineSummary = exit.summary;

    if (record.status === "stopped") {
      // A user-requested stop is not a failure; leave the status as set by stop().
    } else if (exit.completed) {
      record.status = "completed";
    } else {
      record.status = "failed";
      record.error =
        record.error ??
        `Engine exited with code ${exit.code ?? "null"}${exit.signal ? ` (signal ${exit.signal})` : ""}.` +
          (record.engineLog.length > 0 ? ` Last output: ${record.engineLog[record.engineLog.length - 1]}` : "");
    }

    this.publish(record);
    for (const subscriber of record.subscribers) record.subscribers.delete(subscriber);
  }

  async stop(id: string): Promise<RunView> {
    const record = this.require(id);
    if (record.status === "running") {
      record.status = "stopped";
      await record.handle?.stop();
    }
    return this.view(record);
  }

  get(id: string): RunView {
    return this.view(this.require(id));
  }

  list(): RunView[] {
    return [...this.runs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).map((record) => this.view(record));
  }

  /** Streams state to a subscriber until the run ends. Returns an unsubscribe function. */
  subscribe(id: string, onUpdate: (view: RunView) => void): () => void {
    const record = this.require(id);
    record.subscribers.add(onUpdate);
    onUpdate(this.view(record));
    return () => record.subscribers.delete(onUpdate);
  }

  async readArtifact(id: string, name: string): Promise<{ artifact: CompiledArtifact; content: string }> {
    const record = this.require(id);
    const artifact = record.artifacts.find((candidate) => candidate.name === name);
    if (!artifact) throw new RunNotFoundError(`Run ${id} has no artifact named "${name}".`);
    return { artifact, content: await readFile(artifact.absolutePath, "utf8") };
  }

  isRunning(id: string): boolean {
    const record = this.runs.get(id);
    return record?.status === "running";
  }

  private require(id: string): RunRecord {
    const record = this.runs.get(id);
    if (!record) throw new RunNotFoundError(`No run with id "${id}".`);
    return record;
  }

  private publish(record: RunRecord): void {
    if (record.subscribers.size === 0) return;
    const view = this.view(record);
    for (const subscriber of record.subscribers) subscriber(view);
  }

  private resolveTarget(target: CreateRunRequest["target"]): PlanTarget {
    const baseUrl = (target?.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new InvalidTargetError("A target baseUrl is required, e.g. http://localhost:8081/api/v3.");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new InvalidTargetError(`"${baseUrl}" is not a valid absolute URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new InvalidTargetError(`Unsupported protocol "${parsed.protocol}" — the AAS REST API is http(s) only.`);
    }
    return {
      baseUrl,
      timeoutSeconds: target.timeoutSeconds && target.timeoutSeconds > 0 ? target.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
      headers: target.headers ?? {},
    };
  }

  private elapsedSeconds(record: RunRecord): number {
    if (record.startedAtMs === undefined) return 0;
    const end = record.endedAtMs ?? Date.now();
    return Math.max(0, Math.round((end - record.startedAtMs) / 1000));
  }

  private errorLog(record: RunRecord): ErrorLogEntry[] {
    const entries: ErrorLogEntry[] = [...record.errorCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_ERROR_ENTRIES)
      .map(([message, { count, firstOffsetMs }]) => ({
        timestamp: formatOffset(firstOffsetMs),
        message: count > 1 ? `${message} ×${count}` : message,
      }));

    if (record.error) entries.unshift({ timestamp: formatOffset(this.elapsedSeconds(record) * 1000), message: record.error });
    return entries;
  }

  /** Projects the internal record onto the `RunState` shape the Run screen already renders. */
  private runState(record: RunRecord, metrics: MetricsSnapshot): RunState {
    const methodStatus: PhaseExecution["status"] =
      record.status === "running" || record.status === "starting"
        ? "running"
        : record.status === "failed"
          ? "failed"
          : record.status === "compiled"
            ? "pending"
            : "done";

    // Only `method` is executed today. The other four phases are reported as skipped rather than
    // done so nobody reads a clean run as "preconditions passed" when no check ran.
    const notImplemented = "not implemented yet — see backend/README.md";
    const phases: Record<PhaseName, PhaseExecution> = {
      preparation: phase("skipped", notImplemented),
      preconditions: phase("skipped", notImplemented),
      method: phase(
        methodStatus,
        `${metrics.requests} request(s), ${metrics.failed} failed${
          record.engineSummary?.droppedIterations ? `, ${record.engineSummary.droppedIterations} dropped` : ""
        }`,
      ),
      postconditions: phase("skipped", notImplemented),
      cleanup: phase("skipped", notImplemented),
    };

    const keyToLoadId = new Map(record.plan.loads.map((load) => [load.key, load.loadId]));

    return {
      id: record.id,
      scenarioId: record.scenarioName,
      connectionId: record.connectionId,
      engineId: record.engineId,
      elapsedSeconds: this.elapsedSeconds(record),
      totalSeconds: Math.round(record.plan.totalDurationSeconds),
      phases,
      activeLoadIds: metrics.activeLoadKeys.map((key) => keyToLoadId.get(key) ?? key),
      requestsPerSecondSeries: record.aggregator.requestsPerSecondSeries(LIVE_SERIES_SECONDS),
      errorLog: this.errorLog(record),
    };
  }

  private view(record: RunRecord): RunView {
    const metrics = record.aggregator.snapshot();
    return {
      id: record.id,
      status: record.status,
      scenarioName: record.scenarioName,
      connectionId: record.connectionId,
      engineId: record.engineId,
      targetBaseUrl: record.plan.target.baseUrl,
      createdAt: new Date(record.createdAtMs).toISOString(),
      endedAt: record.endedAtMs ? new Date(record.endedAtMs).toISOString() : undefined,
      state: this.runState(record, metrics),
      plan: {
        totalDurationSeconds: record.plan.totalDurationSeconds,
        loadCount: record.plan.loads.length,
        expectedRequests: record.plan.expectedRequests,
        loads: record.plan.loads.map((load) => ({
          key: load.key,
          loadId: load.loadId,
          trackId: load.trackId,
          label: load.label,
          startSeconds: load.startSeconds,
          requestCount: load.requests.length,
        })),
      },
      metrics,
      warnings: record.warnings,
      engineSummary: record.engineSummary,
      artifacts: record.artifacts.map(({ name, description, contentType }) => ({ name, description, contentType })),
      engineLog: record.engineLog.slice(-20),
      error: record.error,
    };
  }
}

export class RunNotFoundError extends Error {}
export class EngineUnavailableError extends Error {}
export class EmptyPlanError extends Error {}
export class InvalidTargetError extends Error {}
export { TimelineValidationError };
