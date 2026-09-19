/**
 * Server-side aggregation of engine samples.
 *
 * The proposal (section 7.2) originally ruled out forwarding raw per-request events to the
 * browser at all; that rule is deliberately overridden here — the Run screen's request/response
 * log needs the real per-request rows (timestamp, status, load), not an aggregate pretending to be
 * one. What survives from §7.2 is the *reason* it existed: the tool's own footprint must not
 * compete with the load it is generating (section 2.3). So the override is split in two:
 *
 *  - `recentSamples` — a small, fixed-size ring buffer of the most recent requests, re-published
 *    on every live tick while a run is active. This is what the Run screen's log renders *during*
 *    a run: cheap enough to serialize every second regardless of run length or request rate.
 *  - `fullLog()` — every request the run has produced, capped only by a generous safety ceiling
 *    (`FULL_LOG_SAFETY_CAP`), never re-published on a timer. `RunService` only ever calls this
 *    once a run has reached a terminal status, and only in response to an explicit request (see
 *    `GET /api/runs/:id/requests`) — so its cost is paid once, after the run stops competing with
 *    anything, never per tick while it is still running.
 *
 * Memory is otherwise bounded on every axis that could grow with run length or request rate:
 * per-second buckets are capped, and the latency distribution is a fixed-size reservoir rather
 * than every observation.
 */

import type { RequestSample } from "../engines/adapter.ts";

/** ~1 hour of per-second buckets; longer runs drop their oldest seconds from the live series but
 *  keep their totals, and the full-resolution record is still on disk. */
const MAX_BUCKETS = 3600;
/** Reservoir size for the latency distribution. 5000 samples put the p99 estimate well inside the
 *  run-to-run noise of the thing being measured, at a fixed ~40 KB. */
const RESERVOIR_SIZE = 5000;
/** How many of the most recent requests the Run screen's *live* log can show while a run is still
 *  active. Small on purpose — it is a "what just happened" window, re-published on every tick, so
 *  this also bounds the size of every live SSE update while a run is running. `fullLog()` is the
 *  complete record; this is only ever the tail of it. */
const RECENT_SAMPLES_LIMIT = 300;
/** Hard ceiling on `fullLog()` — not a design target, a backstop against an unbounded run
 *  eventually exhausting memory. At ~150 bytes/sample this is on the order of tens of MB; a run
 *  that reaches it gets a truncated log (oldest requests dropped) rather than an OOM. */
const FULL_LOG_SAFETY_CAP = 500_000;

export interface LoadTotals {
  requests: number;
  failed: number;
  durationMsSum: number;
}

export interface SecondBucket {
  second: number;
  requests: number;
  failed: number;
  durationMsSum: number;
}

export interface MetricsSnapshot {
  requests: number;
  failed: number;
  /** Mean latency across the whole run so far, in ms. */
  meanDurationMs: number;
  percentiles: { p50: number; p95: number; p99: number; max: number };
  byLoad: Record<string, LoadTotals>;
  byOperation: Record<string, LoadTotals>;
  byStatus: Record<string, number>;
  /** Loads that have been observed issuing requests in the most recent second. */
  activeLoadKeys: string[];
  /** The most recent `RECENT_SAMPLES_LIMIT` requests, oldest first — see the module doc comment
   *  for why this one field carries raw events at all. */
  recentSamples: RequestSample[];
}

export class MetricsAggregator {
  private readonly buckets = new Map<number, SecondBucket>();
  private readonly loadTotals = new Map<string, LoadTotals>();
  private readonly operationTotals = new Map<string, LoadTotals>();
  private readonly statusCounts = new Map<number, number>();
  private readonly reservoir: number[] = [];
  private readonly recentSamples: RequestSample[] = [];
  private readonly log: RequestSample[] = [];
  private logTruncated = false;

  private totalRequests = 0;
  private totalFailed = 0;
  private totalDurationMs = 0;
  private latestSecond = -1;
  /** Loads seen in `latestSecond`, for the Run screen's "active now" highlighting. */
  private activeThisSecond = new Set<string>();

  add(samples: RequestSample[]): void {
    for (const sample of samples) {
      const second = Math.floor(sample.offsetMs / 1000);

      this.totalRequests += 1;
      this.totalDurationMs += sample.durationMs;
      if (sample.failed) this.totalFailed += 1;

      this.bucketFor(second, sample);
      this.accumulate(this.loadTotals, sample.loadKey, sample);
      this.accumulate(this.operationTotals, `${sample.operation}:${sample.target}`, sample);
      this.statusCounts.set(sample.status, (this.statusCounts.get(sample.status) ?? 0) + 1);
      this.sampleLatency(sample.durationMs);
      this.recentSamples.push(sample);
      if (this.recentSamples.length > RECENT_SAMPLES_LIMIT) this.recentSamples.shift();
      if (this.log.length < FULL_LOG_SAFETY_CAP) this.log.push(sample);
      else this.logTruncated = true;

      if (second > this.latestSecond) {
        this.latestSecond = second;
        this.activeThisSecond = new Set([sample.loadKey]);
      } else if (second === this.latestSecond) {
        this.activeThisSecond.add(sample.loadKey);
      }
    }
  }

  private bucketFor(second: number, sample: RequestSample): void {
    let bucket = this.buckets.get(second);
    if (!bucket) {
      bucket = { second, requests: 0, failed: 0, durationMsSum: 0 };
      this.buckets.set(second, bucket);
      if (this.buckets.size > MAX_BUCKETS) {
        // Map preserves insertion order, and samples arrive in time order, so the first key is the
        // oldest second.
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
    }
    bucket.requests += 1;
    bucket.durationMsSum += sample.durationMs;
    if (sample.failed) bucket.failed += 1;
  }

  private accumulate(into: Map<string, LoadTotals>, key: string, sample: RequestSample): void {
    let totals = into.get(key);
    if (!totals) {
      totals = { requests: 0, failed: 0, durationMsSum: 0 };
      into.set(key, totals);
    }
    totals.requests += 1;
    totals.durationMsSum += sample.durationMs;
    if (sample.failed) totals.failed += 1;
  }

  /** Reservoir sampling: every observation has an equal chance of being retained, so the estimate
   *  stays representative of the whole run rather than of its first few seconds. */
  private sampleLatency(durationMs: number): void {
    if (this.reservoir.length < RESERVOIR_SIZE) {
      this.reservoir.push(durationMs);
      return;
    }
    const index = Math.floor(Math.random() * this.totalRequests);
    if (index < RESERVOIR_SIZE) this.reservoir[index] = durationMs;
  }

  /** Requests-per-second for the most recent `limit` seconds, oldest first. Gaps (seconds in which
   *  nothing completed) are rendered as zeros rather than skipped, so the series stays on a real
   *  time axis. */
  requestsPerSecondSeries(limit: number): number[] {
    if (this.buckets.size === 0) return [];
    const seconds = [...this.buckets.keys()].sort((a, b) => a - b);
    const last = seconds[seconds.length - 1];
    const first = Math.max(seconds[0], last - limit + 1);

    const series: number[] = [];
    for (let second = first; second <= last; second++) {
      series.push(this.buckets.get(second)?.requests ?? 0);
    }
    return series;
  }

  buckets_(): SecondBucket[] {
    return [...this.buckets.values()].sort((a, b) => a.second - b.second);
  }

  /** Every request recorded so far, oldest first — see the module doc comment for when this is
   *  meant to be called (once, after a run stops, not on a live-tick cadence). `truncated` is true
   *  only if `FULL_LOG_SAFETY_CAP` was actually reached, which no ordinary run should approach. */
  fullLog(): { samples: RequestSample[]; truncated: boolean } {
    return { samples: [...this.log], truncated: this.logTruncated };
  }

  snapshot(): MetricsSnapshot {
    const sorted = [...this.reservoir].sort((a, b) => a - b);
    const at = (q: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
      return Math.round(sorted[index] * 100) / 100;
    };

    return {
      requests: this.totalRequests,
      failed: this.totalFailed,
      meanDurationMs: this.totalRequests === 0 ? 0 : Math.round((this.totalDurationMs / this.totalRequests) * 100) / 100,
      percentiles: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length === 0 ? 0 : sorted[sorted.length - 1] },
      byLoad: Object.fromEntries(this.loadTotals),
      byOperation: Object.fromEntries(this.operationTotals),
      byStatus: Object.fromEntries([...this.statusCounts].map(([status, count]) => [String(status), count])),
      activeLoadKeys: [...this.activeThisSecond],
      recentSamples: [...this.recentSamples],
    };
  }
}
