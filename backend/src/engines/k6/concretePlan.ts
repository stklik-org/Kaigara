/**
 * Projects a `K6Plan` into a load-tool debug view — the "concrete" plan behind the Run screen's
 * toggle (`POST /api/runs/concrete-plan`). Per ADR 0004, `RunService.concretePlan()` calls
 * `planTimeline()` and this module directly — there is no engine-neutral plan type for it to go
 * through instead — and, like `planTimeline()`, it never contacts the target.
 *
 * One entry per authored load: when k6 starts it, for how long, on which executor, at what rate —
 * read off `PlannedLoad.executor`, the load's shape as one full-rate executor. Below it, one line
 * per request type, which is exactly one generated script each (ADR 0005): its path and the
 * requests that script's own executor is expected to issue.
 *
 * Totals are expectations: each script's executor fires on schedule, but only as fast as the target
 * lets it.
 */

import type {
  ConcretePlan,
  ConcretePlanEntry,
  ConcretePlanRequestLine,
  ValidationIssue,
} from "@kaigara/shared-types";

import {
  describeExecutor,
  executorWindowSeconds,
  peakRatePerSecond,
  type K6Plan,
  type PlannedLoad,
} from "./k6Plan.ts";
import { requestLine } from "./scriptTemplates.ts";

function entryFor(load: PlannedLoad): ConcretePlanEntry {
  const requests: ConcretePlanRequestLine[] = load.scripts.map((script) => ({
    requestId: script.requestId,
    operation: script.operation,
    target: script.target,
    method: script.method,
    path: requestLine(script).slice(script.method.length + 1),
    share: script.share,
    expectedRequests: script.expectedRequests,
  }));

  const peak = peakRatePerSecond(load.executor);
  return {
    loadId: load.loadId,
    loadKey: load.key,
    loadLabel: load.label,
    trackLabel: load.trackLabel,
    shapeKind: load.shapeKind,
    startSeconds: Math.round(load.startSeconds),
    durationSeconds: Math.round(executorWindowSeconds(load.executor)),
    executor: load.executor.executor,
    rateSummary: describeExecutor(load.executor, load.shapeKind),
    ...(peak !== undefined ? { peakRatePerSec: Math.round(peak * 100) / 100 } : {}),
    expectedRequests: requests.reduce((sum, request) => sum + request.expectedRequests, 0),
    requests,
  };
}

export function buildConcretePlan(plan: K6Plan, warnings: ValidationIssue[]): ConcretePlan {
  const entries = plan.loads
    .map(entryFor)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.trackLabel.localeCompare(b.trackLabel) || a.loadKey.localeCompare(b.loadKey));

  return {
    scenarioName: plan.scenarioName,
    targetBaseUrl: plan.target.baseUrl,
    totalDurationSeconds: plan.totalDurationSeconds,
    expectedRequests: entries.reduce((sum, entry) => sum + entry.expectedRequests, 0),
    entries,
    warnings,
  };
}
