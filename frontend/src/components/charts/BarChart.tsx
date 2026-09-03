import type { ErrorBreakdownEntry } from "@kaigara/shared-types";
import { scaleLinear } from "./scale";

const W = 300;
const H = 110;
const PAD_BOTTOM = 14;

export function BarChart({ entries }: { entries: ErrorBreakdownEntry[] }) {
  const max = Math.max(...entries.map((e) => e.count), 1);
  const y = scaleLinear([0, max], [H - PAD_BOTTOM, 6]);
  const bandWidth = W / entries.length;
  const barWidth = bandWidth * 0.5;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[140px] w-full">
        <line x1={0} y1={H - PAD_BOTTOM} x2={W} y2={H - PAD_BOTTOM} className="stroke-border-strong" />
        {entries.map((e, i) => {
          const cx = i * bandWidth + bandWidth / 2;
          return (
            <rect
              key={e.type}
              x={cx - barWidth / 2}
              y={y(e.count)}
              width={barWidth}
              height={H - PAD_BOTTOM - y(e.count)}
              className="fill-status-fail"
              opacity={0.75}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[13px] text-ink-muted">
        {entries.map((e) => (
          <span key={e.type}>{e.type}</span>
        ))}
      </div>
    </div>
  );
}
