/**
 * Shared geometry and colour vocabulary for the hand-rolled SVG charts.
 *
 * All of them draw into the same 300-unit-wide viewBox and scale it to the container with
 * `preserveAspectRatio="none"`, so the numbers here are viewBox units, not pixels — only the
 * `className` heights the callers pass are real CSS.
 */
export const CHART_WIDTH = 300;

/**
 * The colour a series is drawn in.
 *
 * Both the line and its legend dot have to be written out as literal Tailwind class names:
 * Tailwind scans the source for complete class strings, so a computed `stroke-${name}` produces no
 * CSS at all. This map is what lets a caller name a colour once and get a matching stroke and dot
 * without a `className.replace("stroke-", "bg-")` — a transform that silently produced an unstyled
 * dot the moment a caller passed anything else.
 */
export const SERIES_STYLES = {
  accent: { stroke: "stroke-accent", dot: "bg-accent" },
  pass: { stroke: "stroke-status-pass", dot: "bg-status-pass" },
  fail: { stroke: "stroke-status-fail", dot: "bg-status-fail" },
  warn: { stroke: "stroke-status-warn", dot: "bg-status-warn" },
} as const;

export type SeriesColor = keyof typeof SERIES_STYLES;
