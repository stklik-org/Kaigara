import type { ReactNode } from "react";
import { SERIES_STYLES, type SeriesColor } from "./chartStyles";

/** Legend for a multi-series chart: a colour dot per series, under the plot. */
export function ChartLegend({ entries }: { entries: { label: string; color: SeriesColor }[] }) {
  return (
    <div className="mt-1 flex gap-3 text-[12px]">
      {entries.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1 text-ink-muted">
          <span className={`h-2 w-2 rounded-full ${SERIES_STYLES[entry.color].dot}`} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

/** The category names under a bar/box chart, spread to match the bands they label. */
export function CategoryLabels({ labels }: { labels: { key: string; text: ReactNode; className?: string }[] }) {
  return (
    <div className="mt-1 flex justify-between text-[13px] text-ink-muted">
      {labels.map((label) => (
        <span key={label.key} className={label.className}>
          {label.text}
        </span>
      ))}
    </div>
  );
}
