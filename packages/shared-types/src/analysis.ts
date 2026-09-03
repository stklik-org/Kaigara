/** A single value with a symmetric confidence interval, e.g. "842 req/s (95% CI ±18)". */
export interface ValueWithCI {
  value: number;
  ci95: number;
}

export interface StatCard {
  label: string;
  value: string;
  ci?: string;
}

export interface TimeSeriesPoint {
  t: number;
  value: number;
}

export interface CIBandSeries {
  points: TimeSeriesPoint[];
  ciLow: number[];
  ciHigh: number[];
}

export interface PercentileSeries {
  p50: TimeSeriesPoint[];
  p95: TimeSeriesPoint[];
  p99: TimeSeriesPoint[];
}

export interface HistogramBin {
  label: string;
  count: number;
  errorLow: number;
  errorHigh: number;
}

export interface BoxPlotStat {
  track: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Negative-test tracks (e.g. Spike, which sends invalid payloads) are visually distinguished
   *  — carried over from wireframe 1e's per-branch equivalent. */
  isNegativeTest?: boolean;
}

/** One Track's own throughput-over-time — the new Analyze screen (wireframe 2e) breaks
 *  everything down per load Track instead of per graph branch, per-track charts included. */
export interface TrackThroughput {
  trackId: string;
  label: string;
  series: CIBandSeries;
}

export interface ErrorBreakdownEntry {
  type: string;
  count: number;
}

export interface CorrectnessCheckResult {
  phase: "precondition" | "postcondition";
  name: string;
  passed: boolean;
}

export interface RunAnalysis {
  runId: string;
  scenarioName: string;
  connectionName: string;
  timestamp: string;
  durationLabel: string;
  stats: StatCard[];
  throughput: CIBandSeries;
  throughputByTrack: TrackThroughput[];
  latencyPercentiles: PercentileSeries;
  latencyHistogram: HistogramBin[];
  latencyByTrack: BoxPlotStat[];
  resourceUsage: { cpu: TimeSeriesPoint[]; memory: TimeSeriesPoint[] };
  errorBreakdown: ErrorBreakdownEntry[];
  correctnessChecks: CorrectnessCheckResult[];
  aiSummary: string;
}
