import { CHART_WIDTH } from "./chartStyles";
import { extent, polylinePoints, scaleLinear } from "./scale";

const H = 90;
const PAD = 8;

export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const [min, max] = extent(values);
  const x = scaleLinear([0, Math.max(values.length - 1, 1)], [0, CHART_WIDTH]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  return (
    <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className={className}>
      <polyline points={polylinePoints(values, x, y)} className="fill-none stroke-accent" strokeWidth={2} />
    </svg>
  );
}
