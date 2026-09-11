import type { ErrorBreakdownEntry } from "@kaigara/shared-types";
import { CategoryLabels } from "./ChartChrome";
import { CHART_WIDTH } from "./chartStyles";
import { bandLayout, scaleLinear } from "./scale";

const H = 110;
const PAD_BOTTOM = 14;
const BAR_RATIO = 0.5;

export function BarChart({ entries }: { entries: ErrorBreakdownEntry[] }) {
  const max = Math.max(...entries.map((e) => e.count), 1);
  const y = scaleLinear([0, max], [H - PAD_BOTTOM, 6]);
  const { markWidth, centerOf } = bandLayout(CHART_WIDTH, entries.length, BAR_RATIO);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${H}`} preserveAspectRatio="none" className="h-[140px] w-full">
        <line x1={0} y1={H - PAD_BOTTOM} x2={CHART_WIDTH} y2={H - PAD_BOTTOM} className="stroke-border-strong" />
        {entries.map((entry, i) => (
          <rect
            key={entry.type}
            x={centerOf(i) - markWidth / 2}
            y={y(entry.count)}
            width={markWidth}
            height={H - PAD_BOTTOM - y(entry.count)}
            className="fill-status-fail"
            opacity={0.75}
          />
        ))}
      </svg>
      <CategoryLabels labels={entries.map((entry) => ({ key: entry.type, text: entry.type }))} />
    </div>
  );
}
