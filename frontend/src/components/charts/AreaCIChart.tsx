import type { CIBandSeries } from "@kaigara/shared-types";
import { extent, scaleLinear } from "./scale";

const W = 300;
const H = 140;
const PAD = 8;

export function AreaCIChart({ series }: { series: CIBandSeries }) {
  const values = series.points.map((p) => p.value);
  const [min, max] = extent([...values, ...series.ciLow, ...series.ciHigh]);
  const x = scaleLinear([0, Math.max(series.points.length - 1, 1)], [0, W]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  const line = series.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const bandTop = series.ciHigh.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const bandBottom = series.ciLow
    .map((v, i) => `${x(i)},${y(v)}`)
    .reverse()
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[175px] w-full">
      <polygon points={`${bandTop} ${bandBottom}`} className="fill-accent" opacity={0.15} />
      <polyline points={line} className="fill-none stroke-accent" strokeWidth={2} />
    </svg>
  );
}
