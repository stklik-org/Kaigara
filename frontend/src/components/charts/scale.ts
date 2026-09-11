/**
 * Minimal hand-rolled SVG chart primitives, deliberately dependency-free for now — they exist so
 * every screen has a real chart to look at with mock data. The proposal (§7.1) recommends uPlot
 * for production use because of its low CPU/memory footprint while streaming; swap these for
 * uPlot-backed equivalents behind the same prop shape once real metrics are wired up.
 */

/** Maps `domain` onto `range` linearly. A zero-width domain (a flat series) maps everything to
 *  `range[0]` rather than dividing by zero. */
export function scaleLinear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** `[min, max]` of `values`, or `[0, 1]` for an empty series so callers still get a usable scale. */
export function extent(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

/** Formats a series as an SVG `points` list. Every chart here plots evenly-spaced samples, so the
 *  x position is always the sample's index run through `x`. */
export function polylinePoints(values: number[], x: (i: number) => number, y: (v: number) => number): string {
  return values.map((value, i) => `${x(i)},${y(value)}`).join(" ");
}

/** Evenly divides the chart width into `count` bands and centres a mark of `markRatio` of a band's
 *  width in each — the layout every categorical chart here (bars, histogram bins, box plots) uses,
 *  and the reason none of them recomputes `i * bandWidth + bandWidth / 2` itself. */
export function bandLayout(width: number, count: number, markRatio: number) {
  const bandWidth = width / Math.max(count, 1);
  return { markWidth: bandWidth * markRatio, centerOf: (i: number) => i * bandWidth + bandWidth / 2 };
}
