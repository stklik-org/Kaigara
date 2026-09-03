/**
 * Minimal hand-rolled SVG chart primitives, deliberately dependency-free for now — they exist so
 * every screen has a real chart to look at with mock data. The proposal (§7.1) recommends uPlot
 * for production use because of its low CPU/memory footprint while streaming; swap these for
 * uPlot-backed equivalents behind the same prop shape once real metrics are wired up.
 */
export function scaleLinear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

export function extent(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}
