import type { RunAnalysis, TrackThroughput } from "@kaigara/shared-types";

const throughputValues = [655, 730, 705, 815, 835, 900, 870, 940, 915, 975, 955];

function trackSeries(label: string, trackId: string, values: number[], ciSpread: number): TrackThroughput {
  return {
    trackId,
    label,
    series: {
      points: values.map((value, t) => ({ t, value })),
      ciLow: values.map((v) => Math.max(0, v - ciSpread)),
      ciHigh: values.map((v) => v + ciSpread),
    },
  };
}

export const mockRunAnalysis: RunAnalysis = {
  runId: "482",
  scenarioName: "component-manufacturer-v1",
  connectionName: "twinsphere",
  timestamp: "24 Jul 2026, 14:02",
  durationLabel: "10m",
  stats: [
    { label: "req/s avg", value: "842", ci: "95% CI ±18" },
    { label: "P95 latency", value: "118ms", ci: "±9ms" },
    { label: "P99 latency", value: "241ms", ci: "±22ms" },
    { label: "error rate", value: "0.4%" },
    { label: "peak CPU", value: "61%" },
  ],
  throughput: {
    points: throughputValues.map((value, t) => ({ t, value })),
    ciLow: throughputValues.map((v) => v - 22),
    ciHigh: throughputValues.map((v) => v + 22),
  },
  throughputByTrack: [
    trackSeries("Ramp up/down", "ramp", [40, 180, 380, 220, 60, 30, 300, 380, 210, 50, 20], 12),
    trackSeries("Periodic burst", "periodic-burst", [10, 250, 60, 10, 260, 55, 10, 250, 60, 10, 10], 10),
    trackSeries("Peak event", "peak-event", [5, 5, 120, 400, 300, 90, 5, 5, 5, 5, 5], 15),
    trackSeries("Spike tests", "spike", [5, 220, 5, 210, 5, 5, 5, 200, 5, 190, 5], 8),
    trackSeries("Base load", "base-load", [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], 4),
  ],
  latencyPercentiles: {
    p50: [58, 60, 62, 63, 65, 66].map((value, t) => ({ t, value })),
    p95: [95, 100, 108, 112, 118, 122].map((value, t) => ({ t, value })),
    p99: [150, 165, 185, 205, 228, 241].map((value, t) => ({ t, value })),
  },
  latencyHistogram: [
    { label: "0-25ms", count: 50, errorLow: 44, errorHigh: 56 },
    { label: "25-50ms", count: 80, errorLow: 70, errorHigh: 90 },
    { label: "50-100ms", count: 110, errorLow: 98, errorHigh: 122 },
    { label: "100-150ms", count: 70, errorLow: 60, errorHigh: 80 },
    { label: "150-200ms", count: 40, errorLow: 32, errorHigh: 48 },
    { label: "200-300ms", count: 20, errorLow: 14, errorHigh: 26 },
    { label: "300ms+", count: 8, errorLow: 4, errorHigh: 12 },
  ],
  latencyByTrack: [
    { track: "Ramp up/down", min: 20, q1: 45, median: 58, q3: 70, max: 95 },
    { track: "Periodic burst", min: 30, q1: 60, median: 78, q3: 95, max: 130 },
    { track: "Peak event", min: 35, q1: 65, median: 85, q3: 105, max: 145 },
    { track: "Base load", min: 15, q1: 35, median: 48, q3: 58, max: 80 },
    { track: "Spike tests", min: 55, q1: 95, median: 118, q3: 150, max: 195, isNegativeTest: true },
  ],
  resourceUsage: {
    cpu: [22, 28, 33, 42, 47, 55, 51, 58, 56, 61, 60].map((value, t) => ({ t, value })),
    memory: [12, 13, 15, 16, 17, 18, 19, 20, 20, 21, 22].map((value, t) => ({ t, value })),
  },
  errorBreakdown: [
    { type: "500 (validation)", count: 70 },
    { type: "timeout", count: 30 },
    { type: "409 conflict", count: 10 },
    { type: "other", count: 5 },
  ],
  correctnessChecks: [
    { phase: "precondition", name: "conformance", passed: true },
    { phase: "precondition", name: "schema", passed: true },
    { phase: "postcondition", name: "schema", passed: true },
    { phase: "postcondition", name: "no-orphan-refs", passed: false },
  ],
  aiSummary:
    "Throughput steady until 6m, then latency climbed — likely GC pause; error rate driven almost entirely by the Spike track's intentional invalid-write negative tests, not server faults; 1 postcondition check failed (orphan refs after concurrent writes).",
};
