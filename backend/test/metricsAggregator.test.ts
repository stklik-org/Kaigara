import test from "node:test";
import assert from "node:assert/strict";

import { MetricsAggregator } from "../src/runs/metricsAggregator.ts";
import type { RequestSample } from "../src/engines/adapter.ts";

function sample(offsetMs: number, overrides: Partial<RequestSample> = {}): RequestSample {
  return {
    offsetMs,
    loadKey: "load-a",
    operation: "read",
    target: "shell",
    durationMs: 12,
    status: 200,
    failed: false,
    ...overrides,
  };
}

test("recentSamples keeps every request while under the cap, oldest first", () => {
  const aggregator = new MetricsAggregator();
  aggregator.add([sample(0), sample(10), sample(20)]);

  const { recentSamples } = aggregator.snapshot();
  assert.deepEqual(
    recentSamples.map((s) => s.offsetMs),
    [0, 10, 20],
  );
});

test("recentSamples drops the oldest once past its cap, keeping the window bounded", () => {
  const aggregator = new MetricsAggregator();
  const total = 350; // past RECENT_SAMPLES_LIMIT (300)
  aggregator.add(Array.from({ length: total }, (_, i) => sample(i)));

  const { recentSamples } = aggregator.snapshot();
  assert.equal(recentSamples.length, 300);
  // The oldest 50 were pushed out; what's left is a contiguous, oldest-first tail.
  assert.equal(recentSamples[0].offsetMs, 50);
  assert.equal(recentSamples[recentSamples.length - 1].offsetMs, total - 1);
});

test("recentSamples does not affect the aggregate counters it rides alongside", () => {
  const aggregator = new MetricsAggregator();
  aggregator.add(Array.from({ length: 350 }, (_, i) => sample(i, { status: i % 2 === 0 ? 200 : 404, failed: i % 2 !== 0 })));

  const snapshot = aggregator.snapshot();
  // The aggregates still count all 350, even though recentSamples only holds the newest 300.
  assert.equal(snapshot.requests, 350);
  assert.equal(snapshot.byStatus["200"], 175);
  assert.equal(snapshot.byStatus["404"], 175);
  assert.equal(snapshot.recentSamples.length, 300);
});
