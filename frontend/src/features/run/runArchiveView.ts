import type { RunArchiveDetail, RunLifecycleStatus, RunView } from "@kaigara/shared-types";

/**
 * Projects an archived run (`GET /api/runs/archive/:id`) onto the same `RunView` shape a live run
 * uses, so "open previous execution" can reuse every Run screen component as-is — the header
 * badge, `RunLoadShapePanel`/`RunCompositionPanel` (via the restored `scenarioStore` timeline),
 * `RequestResponseView`, the bottom stats grid — rather than a second, parallel rendering path.
 *
 * Derived rather than copied where the archive does not carry a field outright: percentiles and
 * `byStatus` come from re-deriving them over `requestLog.samples`, the same way
 * `MetricsAggregator.snapshot()` derives them from the samples it has seen — this is the *complete*
 * log, not a bounded tail, so the numbers are exact, not an approximation of the live view's.
 */
export function runViewFromArchive(detail: RunArchiveDetail): RunView {
  const { manifest, plan, requestLog } = detail;
  const status: RunLifecycleStatus = (manifest.status as RunLifecycleStatus | undefined) ?? "compiled";
  const totalSeconds = plan?.totalDurationSeconds ?? 0;
  const elapsedSeconds =
    manifest.endedAt != null
      ? Math.max(0, Math.round((Date.parse(manifest.endedAt) - Date.parse(manifest.calledAt)) / 1000))
      : totalSeconds;

  const samples = requestLog?.samples ?? [];
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentileAt = (q: number): number => {
    if (durations.length === 0) return 0;
    const index = Math.min(durations.length - 1, Math.max(0, Math.ceil(q * durations.length) - 1));
    return Math.round(durations[index] * 100) / 100;
  };
  const byStatus: Record<string, number> = {};
  for (const sample of samples) byStatus[String(sample.status)] = (byStatus[String(sample.status)] ?? 0) + 1;

  return {
    id: manifest.runId,
    status,
    scenarioName: manifest.scenarioName,
    // Not recorded in the archive today (see RunArchiveManifest) — nothing in the Run screen reads
    // this for an archived view except the target-label fallback, which `RunPage` special-cases
    // for a non-live run so an empty connectionId here never resolves to the wrong connection.
    connectionId: "",
    engineId: manifest.engineId,
    targetBaseUrl: manifest.targetBaseUrl,
    createdAt: manifest.calledAt,
    endedAt: manifest.endedAt,
    state: {
      id: manifest.runId,
      scenarioId: "",
      connectionId: "",
      engineId: manifest.engineId,
      elapsedSeconds,
      totalSeconds,
      phases: {
        preparation: { status: "skipped" },
        preconditions: { status: "skipped" },
        method: { status: status === "failed" ? "failed" : "done" },
        postconditions: { status: "skipped" },
        cleanup: { status: "skipped" },
      },
      activeLoadIds: [],
      requestsPerSecondSeries: [],
      errorLog: [],
    },
    plan: plan ?? { totalDurationSeconds: 0, loadCount: 0, expectedRequests: 0, loads: [] },
    metrics: {
      requests: manifest.requests ?? samples.length,
      failed: manifest.failed ?? samples.filter((sample) => sample.failed).length,
      meanDurationMs:
        durations.length === 0 ? 0 : Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 100) / 100,
      percentiles: {
        p50: percentileAt(0.5),
        p95: percentileAt(0.95),
        p99: percentileAt(0.99),
        max: durations.length === 0 ? 0 : durations[durations.length - 1],
      },
      byLoad: {},
      byOperation: {},
      byStatus,
      activeLoadKeys: [],
      // Not the live tail's usual meaning (this run is not live) — RunPage feeds the same complete
      // samples through the `fullLog` prop `RequestResponseView` already prefers when present, so
      // this is only ever a fallback for a caller that reads `metrics.recentSamples` directly.
      recentSamples: samples.slice(-300),
    },
    warnings: [],
    artifacts: [],
    engineLog: [],
  };
}
