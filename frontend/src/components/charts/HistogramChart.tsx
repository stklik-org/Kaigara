import type { HistogramBin } from "@kaigara/shared-types";
import { scaleLinear } from "./scale";

const W = 300;
const H = 150;
const PAD_BOTTOM = 14;

export function HistogramChart({ bins }: { bins: HistogramBin[] }) {
  const max = Math.max(...bins.map((b) => b.errorHigh), 1);
  const y = scaleLinear([0, max], [H - PAD_BOTTOM, 6]);
  const bandWidth = W / bins.length;
  const barWidth = bandWidth * 0.55;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[190px] w-full">
        <line x1={0} y1={H - PAD_BOTTOM} x2={W} y2={H - PAD_BOTTOM} className="stroke-border-strong" />
        {bins.map((bin, i) => {
          const cx = i * bandWidth + bandWidth / 2;
          const barX = cx - barWidth / 2;
          return (
            <g key={bin.label}>
              <rect
                x={barX}
                y={y(bin.count)}
                width={barWidth}
                height={H - PAD_BOTTOM - y(bin.count)}
                className="fill-accent"
                opacity={0.75}
              />
              <line x1={cx} y1={y(bin.errorLow)} x2={cx} y2={y(bin.errorHigh)} className="stroke-ink" />
              <line x1={cx - 4} y1={y(bin.errorLow)} x2={cx + 4} y2={y(bin.errorLow)} className="stroke-ink" />
              <line x1={cx - 4} y1={y(bin.errorHigh)} x2={cx + 4} y2={y(bin.errorHigh)} className="stroke-ink" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[13px] text-ink-muted">
        {bins.map((bin) => (
          <span key={bin.label}>{bin.label}</span>
        ))}
      </div>
    </div>
  );
}
