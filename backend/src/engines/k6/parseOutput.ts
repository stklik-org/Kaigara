/**
 * Parses k6's newline-delimited JSON output into engine-neutral `RequestSample`s.
 *
 * k6 emits one JSON object per line, of two kinds: `Metric` (a declaration, once per metric) and
 * `Point` (an observation). Only points matter here, and only three metrics of them:
 *
 *  - `http_req_duration` — one point per completed request, carrying the tags the generated scripts
 *    attach (`load`, `track`, `op`, `target`, `script`) plus k6's own `status` and `expected_response`.
 *    This single metric yields both the request count and the latency, so parsing it alone avoids
 *    walking the output twice.
 *  - `dropped_iterations` — requests k6 wanted to start but could not, because its worker pool was
 *    saturated. Surfaced prominently: it means the measurement was limited by the load generator
 *    rather than by the server under test.
 *  - `kaigara_skipped_no_id` — the generated scripts' own counter for iterations that had no
 *    identifier left to address.
 *
 * The volume is substantial (one line per request per metric), which is exactly why the proposal
 * (section 7.2) calls for aggregating server-side rather than forwarding raw events to the
 * browser: this parser is the first stage of that, and `metricsAggregator.ts` is the second.
 */

import type { RequestSample } from "../adapter.ts";

export interface ParsedBatch {
  samples: RequestSample[];
  /** Iterations k6 could not start because `preAllocatedVUs`/`maxVUs` were too low. */
  droppedIterations: number;
  /** Requests the script skipped because no identifier was available. */
  skippedNoId: number;
}

interface K6Line {
  type?: string;
  metric?: string;
  data?: {
    time?: string;
    value?: number;
    tags?: Record<string, string>;
  };
}

/**
 * Incremental, chunk-safe parser. k6 writes continuously and a read can land mid-line, so the
 * trailing partial line is held back until the rest of it arrives.
 */
export class K6OutputParser {
  private remainder = "";
  // Written as an explicit field rather than a constructor parameter property: Node runs this
  // source by stripping types, which cannot erase a parameter property (it emits an assignment),
  // so `erasableSyntaxOnly` rejects them.
  private readonly startEpochMs: number;

  constructor(startEpochMs: number) {
    this.startEpochMs = startEpochMs;
  }

  /** Feeds a chunk of raw output; returns whatever complete lines it contained. */
  push(chunk: string): ParsedBatch {
    const batch: ParsedBatch = { samples: [], droppedIterations: 0, skippedNoId: 0 };

    const text = this.remainder + chunk;
    const lines = text.split("\n");
    // The final element is either "" (chunk ended on a newline) or a partial line to carry over.
    this.remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") continue;
      this.consume(line, batch);
    }
    return batch;
  }

  /** Flushes any trailing line held back by `push` — call once the stream has closed. */
  flush(): ParsedBatch {
    const batch: ParsedBatch = { samples: [], droppedIterations: 0, skippedNoId: 0 };
    if (this.remainder.trim() !== "") this.consume(this.remainder, batch);
    this.remainder = "";
    return batch;
  }

  private consume(line: string, batch: ParsedBatch): void {
    let parsed: K6Line;
    try {
      parsed = JSON.parse(line);
    } catch {
      // k6 can interleave a non-JSON banner line into the stream; skipping it is correct, and
      // failing the whole run over one unparseable line would not be.
      return;
    }

    if (parsed.type !== "Point" || !parsed.data) return;

    switch (parsed.metric) {
      case "http_req_duration": {
        const sample = this.toSample(parsed);
        if (sample) batch.samples.push(sample);
        return;
      }
      case "dropped_iterations":
        batch.droppedIterations += parsed.data.value ?? 0;
        return;
      case "kaigara_skipped_no_id":
        batch.skippedNoId += parsed.data.value ?? 0;
        return;
      default:
        return;
    }
  }

  private toSample(line: K6Line): RequestSample | null {
    const data = line.data;
    if (!data) return null;

    const tags = data.tags ?? {};

    // Anything with no `load` tag belongs to no planned load — the generated scripts tag every
    // request they issue, and they issue nothing else (they discover no server state of their own,
    // ADR 0003). Counting an untagged request would put the tool's own overhead into the numbers it
    // reports (proposal section 2.3).
    if (tags.load === undefined) return null;

    const timestamp = data.time ? Date.parse(data.time) : Number.NaN;
    const offsetMs = Number.isFinite(timestamp) ? Math.max(0, timestamp - this.startEpochMs) : 0;

    return {
      offsetMs,
      loadKey: tags.load ?? "unknown",
      operation: tags.op ?? "unknown",
      target: tags.target ?? "unknown",
      durationMs: data.value ?? 0,
      // Transport failures carry status "0"; parseInt on a missing tag would give NaN, so default.
      status: Number.parseInt(tags.status ?? "0", 10) || 0,
      // `expected_response` is bound to each script's own EXPECTED_STATUS (scriptTemplates.ts),
      // so it is authoritative rather than k6's default 2xx/3xx notion.
      failed: tags.expected_response !== "true",
    };
  }
}

/** Totals from k6's end-of-run summary, used to reconcile the streamed samples against the
 *  engine's own authoritative count. Shape follows k6's `handleSummary` data. */
export function readSummaryTotals(summary: unknown): {
  requests: number;
  failed: number;
  durationMs: { avg?: number; p95?: number; p99?: number; max?: number };
  droppedIterations?: number;
} | null {
  const metrics = (summary as { metrics?: Record<string, unknown> } | undefined)?.metrics;
  if (!metrics || typeof metrics !== "object") return null;

  const reqs = metrics.http_reqs as { values?: { count?: number } } | undefined;
  const failedRate = metrics.http_req_failed as { values?: { passes?: number; fails?: number } } | undefined;
  const duration = metrics.http_req_duration as
    | { values?: { avg?: number; "p(95)"?: number; "p(99)"?: number; max?: number } }
    | undefined;
  const dropped = metrics.dropped_iterations as { values?: { count?: number } } | undefined;

  const requests = reqs?.values?.count ?? 0;
  // k6's http_req_failed is a Rate: `passes` counts the requests that *did* fail the expectation.
  const failed = failedRate?.values?.passes ?? 0;

  return {
    requests,
    failed,
    durationMs: {
      avg: duration?.values?.avg,
      p95: duration?.values?.["p(95)"],
      p99: duration?.values?.["p(99)"],
      max: duration?.values?.max,
    },
    droppedIterations: dropped?.values?.count,
  };
}
