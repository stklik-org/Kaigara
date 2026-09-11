import type { BoxPlotStat } from "@kaigara/shared-types";
import { CategoryLabels } from "./ChartChrome";
import { CHART_WIDTH } from "./chartStyles";
import { bandLayout, extent, scaleLinear } from "./scale";

const H = 150;
const PAD = 10;
const BOX_RATIO = 0.4;

/** Negative-test tracks are drawn in the warning tone rather than the ink one — the wireframe's
 *  convention for a branch whose *failures* are the expected result. */
function toneOf(stat: BoxPlotStat) {
  return stat.isNegativeTest
    ? { stroke: "stroke-status-warn", fill: "fill-status-warn-bg", label: "text-status-warn" }
    : { stroke: "stroke-ink", fill: "fill-surface", label: undefined };
}

export function BoxPlotChart({ stats }: { stats: BoxPlotStat[] }) {
  const [min, max] = extent(stats.flatMap((s) => [s.min, s.max]));
  const y = scaleLinear([min, max], [H - PAD, PAD]);
  const { markWidth, centerOf } = bandLayout(CHART_WIDTH, stats.length, BOX_RATIO);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[190px] w-full">
        {stats.map((stat, i) => {
          const cx = centerOf(i);
          const tone = toneOf(stat);
          return (
            <g key={stat.track}>
              {/* whisker */}
              <line x1={cx} y1={y(stat.min)} x2={cx} y2={y(stat.max)} className={tone.stroke} />
              {/* interquartile box */}
              <rect
                x={cx - markWidth / 2}
                y={y(stat.q3)}
                width={markWidth}
                height={Math.max(y(stat.q1) - y(stat.q3), 1)}
                className={`${tone.fill} ${tone.stroke}`}
                strokeWidth={2}
              />
              {/* median */}
              <line
                x1={cx - markWidth / 2}
                y1={y(stat.median)}
                x2={cx + markWidth / 2}
                y2={y(stat.median)}
                className={tone.stroke}
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      <CategoryLabels
        labels={stats.map((stat) => ({ key: stat.track, text: stat.track, className: toneOf(stat).label }))}
      />
    </div>
  );
}
