import type { HistogramBin } from "@kaigara/shared-types";
import { CategoryLabels } from "./ChartChrome";
import { CHART_WIDTH } from "./chartStyles";
import { bandLayout, scaleLinear } from "./scale";

const H = 150;
const PAD_BOTTOM = 14;
const BAR_RATIO = 0.55;
/** Half-width of the error bar's end caps, in viewBox units. */
const CAP = 4;

export function HistogramChart({ bins }: { bins: HistogramBin[] }) {
  const max = Math.max(...bins.map((b) => b.errorHigh), 1);
  const y = scaleLinear([0, max], [H - PAD_BOTTOM, 6]);
  const { markWidth, centerOf } = bandLayout(CHART_WIDTH, bins.length, BAR_RATIO);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[190px] w-full">
        <line x1={0} y1={H - PAD_BOTTOM} x2={CHART_WIDTH} y2={H - PAD_BOTTOM} className="stroke-border-strong" />
        {bins.map((bin, i) => {
          const cx = centerOf(i);
          return (
            <g key={bin.label}>
              <rect
                x={cx - markWidth / 2}
                y={y(bin.count)}
                width={markWidth}
                height={H - PAD_BOTTOM - y(bin.count)}
                className="fill-accent"
                opacity={0.75}
              />
              <line x1={cx} y1={y(bin.errorLow)} x2={cx} y2={y(bin.errorHigh)} className="stroke-ink" />
              <line x1={cx - CAP} y1={y(bin.errorLow)} x2={cx + CAP} y2={y(bin.errorLow)} className="stroke-ink" />
              <line x1={cx - CAP} y1={y(bin.errorHigh)} x2={cx + CAP} y2={y(bin.errorHigh)} className="stroke-ink" />
            </g>
          );
        })}
      </svg>
      <CategoryLabels labels={bins.map((bin) => ({ key: bin.label, text: bin.label }))} />
    </div>
  );
}
