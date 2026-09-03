import type { PercentileSeries } from "@kaigara/shared-types";
import { extent, scaleLinear } from "./scale";

const W = 300;
const H = 140;
const PAD = 8;

const SERIES: { key: keyof PercentileSeries; label: string; className: string }[] = [
  { key: "p50", label: "P50", className: "stroke-status-pass" },
  { key: "p95", label: "P95", className: "stroke-accent" },
  { key: "p99", label: "P99", className: "stroke-status-fail" },
];

export function PercentileChart({ series }: { series: PercentileSeries }) {
  const all = [...series.p50, ...series.p95, ...series.p99].map((p) => p.value);
  const [min, max] = extent(all);
  const x = scaleLinear([0, Math.max(series.p50.length - 1, 1)], [0, W]);
  const y = scaleLinear([min, max], [H - PAD, PAD]);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[175px] w-full">
        {SERIES.map(({ key, className }) => (
          <polyline
            key={key}
            points={series[key].map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
            className={`fill-none ${className}`}
            strokeWidth={2}
          />
        ))}
      </svg>
      <div className="mt-1 flex gap-3 text-[12px]">
        {SERIES.map(({ key, label, className }) => (
          <span key={key} className="flex items-center gap-1 text-ink-muted">
            <span className={`h-2 w-2 rounded-full ${className.replace("stroke-", "bg-")}`} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
