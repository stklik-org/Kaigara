import type { TimeSeriesPoint } from "@kaigara/shared-types";
import { ChartLegend } from "./ChartChrome";
import { CHART_WIDTH, SERIES_STYLES, type SeriesColor } from "./chartStyles";
import { extent, polylinePoints, scaleLinear } from "./scale";

const H = 110;
const PAD = 8;

export interface LineSeries {
  label: string;
  points: TimeSeriesPoint[];
  color: SeriesColor;
}

/** Several series sharing one y-axis — used for CPU next to memory, where the point is the shape
 *  of the two curves against each other rather than their absolute units. */
export function DualLineChart({ series }: { series: LineSeries[] }) {
  const [min, max] = extent(series.flatMap((s) => s.points.map((p) => p.value)));
  const count = Math.max(...series.map((s) => s.points.length), 1);
  const x = scaleLinear([0, count - 1], [0, CHART_WIDTH]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[140px] w-full">
        {series.map((s) => (
          <polyline
            key={s.label}
            points={polylinePoints(
              s.points.map((p) => p.value),
              x,
              y,
            )}
            className={`fill-none ${SERIES_STYLES[s.color].stroke}`}
            strokeWidth={2}
          />
        ))}
      </svg>
      <ChartLegend entries={series} />
    </div>
  );
}
