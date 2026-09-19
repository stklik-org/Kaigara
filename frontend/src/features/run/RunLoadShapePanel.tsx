import type { Load } from "@kaigara/shared-types";
import { NoLoadSelected, PanelLabel } from "../compose/panels/fields";
import { formatMMSS } from "../compose/timeline/formatTime";
import { getShapeVisual } from "../compose/timeline/shapeVisuals";

/**
 * Read-only sibling of Compose's `LoadShapePanel` — same card, same fields, but static text
 * instead of inputs. A run in progress already executed a *compiled* plan from whatever the
 * timeline looked like when it started, so letting someone edit shape fields here would look like
 * it does something and does nothing; this shows the same information without a single input.
 */
function StaticField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-ink-muted">{label}</div>
      <div className="rounded border border-field-border bg-field px-2 py-1 text-[12px] text-ink">{value}</div>
    </div>
  );
}

export function RunLoadShapePanel({ load }: { load: Load | undefined }) {
  if (!load) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
        <NoLoadSelected />
      </div>
    );
  }

  const visual = getShapeVisual(load.shape);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none px-2 pt-2">
        <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex flex-col gap-2">
          <StaticField label="Shape" value={visual.label} />
          <StaticField label="Start" value={formatMMSS(load.startSeconds)} />
          <StaticField
            label="Duration"
            value={load.shape.instantaneous ? "instantaneous" : formatMMSS(load.durationSeconds)}
          />
          <StaticField label={visual.label === "Individual" ? "Requests" : "Rate"} value={visual.detail} />
        </div>
      </div>
    </div>
  );
}
