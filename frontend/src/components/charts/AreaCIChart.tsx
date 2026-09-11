import type { CIBandSeries } from "@kaigara/shared-types";
import { CHART_WIDTH } from "./chartStyles";
import { extent, polylinePoints, scaleLinear } from "./scale";

const H = 140;
const PAD = 8;

export function AreaCIChart({ series }: { series: CIBandSeries }) {
  const values = series.points.map((p) => p.value);
  const [min, max] = extent([...values, ...series.ciLow, ...series.ciHigh]);
  const x = scaleLinear([0, Math.max(series.points.length - 1, 1)], [0, CHART_WIDTH]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  // The band is one polygon: the upper bound left-to-right, then the lower bound back again.
  const band = `${polylinePoints(series.ciHigh, x, y)} ${series.ciLow
    .map((v, i) => `${x(i)},${y(v)}`)
    .reverse()
    .join(" ")}`;

  return (
    <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[175px] w-full">
      <polygon points={band} className="fill-accent" opacity={0.15} />
      <polyline points={polylinePoints(values, x, y)} className="fill-none stroke-accent" strokeWidth={2} />
    </svg>
  );
}
