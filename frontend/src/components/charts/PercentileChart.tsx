import type { PercentileSeries } from "@kaigara/shared-types";
import { ChartLegend } from "./ChartChrome";
import { CHART_WIDTH, SERIES_STYLES, type SeriesColor } from "./chartStyles";
import { extent, polylinePoints, scaleLinear } from "./scale";

const H = 140;
const PAD = 8;

const SERIES: { key: keyof PercentileSeries; label: string; color: SeriesColor }[] = [
  { key: "p50", label: "P50", color: "pass" },
  { key: "p95", label: "P95", color: "accent" },
  { key: "p99", label: "P99", color: "fail" },
];

export function PercentileChart({ series }: { series: PercentileSeries }) {
  const [min, max] = extent(SERIES.flatMap(({ key }) => series[key].map((p) => p.value)));
  const x = scaleLinear([0, Math.max(series.p50.length - 1, 1)], [0, CHART_WIDTH]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[175px] w-full">
        {SERIES.map(({ key, color }) => (
          <polyline
            key={key}
            points={polylinePoints(
              series[key].map((p) => p.value),
              x,
              y,
            )}
            className={`fill-none ${SERIES_STYLES[color].stroke}`}
            strokeWidth={2}
          />
        ))}
      </svg>
      <ChartLegend entries={SERIES} />
    </div>
  );
}
