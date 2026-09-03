import type { TimeSeriesPoint } from "@kaigara/shared-types";
import { extent, scaleLinear } from "./scale";

const W = 300;
const H = 110;
const PAD = 8;

interface Series {
  label: string;
  points: TimeSeriesPoint[];
  className: string;
}

export function DualLineChart({ series }: { series: Series[] }) {
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const [min, max] = extent(all);
  const count = Math.max(...series.map((s) => s.points.length), 1);
  const x = scaleLinear([0, count - 1], [0, W]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[140px] w-full">
        {series.map((s) => (
          <polyline
            key={s.label}
            points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
            className={`fill-none ${s.className}`}
            strokeWidth={2}
          />
        ))}
      </svg>
      <div className="mt-1 flex gap-3 text-[12px]">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1 text-ink-muted">
            <span className={`h-2 w-2 rounded-full ${s.className.replace("stroke-", "bg-")}`} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
