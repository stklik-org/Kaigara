import { CHART_WIDTH } from "./chartStyles";
import { polylinePoints, scaleLinear } from "./scale";

const H = 90;
const PAD_TOP = 8;
const PAD_BOTTOM = 4;

/** `1234` -> `"1.2k"`, otherwise the rounded integer — keeps the y-axis gutter narrow regardless of
 *  how high req/s climbs. */
function formatTick(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
}

/**
 * A small trend line with a y-axis (0 / half / max, so a reader can tell what the line actually
 * means without hovering) and horizontal gridlines at those same three values. The domain is
 * pinned to `[0, max(values))` rather than `extent(values)` — a rate can't go negative, and always
 * anchoring the baseline at 0 is what makes the line's *height* meaningful at a glance instead of
 * auto-scaling every run's noise floor to fill the same box.
 */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const max = Math.max(0, ...values, 1);
  const x = scaleLinear([0, Math.max(values.length - 1, 1)], [0, CHART_WIDTH]);
  const y = scaleLinear([0, max], [H - PAD_BOTTOM, PAD_TOP]);
  const ticks = [max, max / 2, 0];

  return (
    <div className={`flex items-stretch gap-1.5 ${className}`}>
      <div className="flex w-7 flex-none flex-col justify-between py-0.5 text-right font-mono text-[9px] leading-none text-ink-muted tabular-nums">
        {ticks.map((tick, i) => (
          <span key={i}>{formatTick(tick)}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="min-w-0 flex-1">
        {ticks.map((tick, i) => (
          <line key={i} x1={0} x2={CHART_WIDTH} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <polyline
          points={polylinePoints(values, x, y)}
          className="fill-none stroke-accent"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
