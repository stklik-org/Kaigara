import type { BoxPlotStat } from "@kaigara/shared-types";
import { extent, scaleLinear } from "./scale";

const W = 300;
const H = 150;
const PAD = 10;

export function BoxPlotChart({ stats }: { stats: BoxPlotStat[] }) {
  const [min, max] = extent(stats.flatMap((s) => [s.min, s.max]));
  const y = scaleLinear([min, max], [H - PAD, PAD]);
  const bandWidth = W / stats.length;
  const boxWidth = bandWidth * 0.4;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[190px] w-full">
        {stats.map((s, i) => {
          const cx = i * bandWidth + bandWidth / 2;
          const colorClass = s.isNegativeTest ? "stroke-status-warn" : "stroke-ink";
          const fillClass = s.isNegativeTest ? "fill-status-warn-bg" : "fill-surface";
          return (
            <g key={s.track}>
              <line x1={cx} y1={y(s.min)} x2={cx} y2={y(s.max)} className={colorClass} />
              <rect
                x={cx - boxWidth / 2}
                y={y(s.q3)}
                width={boxWidth}
                height={Math.max(y(s.q1) - y(s.q3), 1)}
                className={`${fillClass} ${colorClass}`}
                strokeWidth={2}
              />
              <line
                x1={cx - boxWidth / 2}
                y1={y(s.median)}
                x2={cx + boxWidth / 2}
                y2={y(s.median)}
                className={colorClass}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[13px] text-ink-muted">
        {stats.map((s) => (
          <span key={s.track} className={s.isNegativeTest ? "text-status-warn" : ""}>
            {s.track}
          </span>
        ))}
      </div>
    </div>
  );
}
