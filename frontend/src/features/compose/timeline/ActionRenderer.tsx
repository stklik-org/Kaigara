import type { TimelineAction } from "@xzdarcy/timeline-engine";
import type { LoadShape } from "@kaigara/shared-types";
import { getShapeVisual, trackColorBg } from "./shapeVisuals";
import type { LiveState } from "./timelineAdapters";

const LIVE_STATE_OPACITY: Record<LiveState, number> = {
  past: 0.35,
  active: 1,
  future: 0.75,
};

type ActionWithShape = TimelineAction & { shape: LoadShape; trackColor: string; liveState?: LiveState };

/** `getActionRender` for <Timeline> — the library renders this inside its own positioned
 *  `.timeline-editor-action` box (sized/positioned by the library), so this only needs to fill
 *  that box with our own glyph/label/color, not worry about position. `shape`, `trackColor`, and
 *  `liveState` are extra fields toTimelineRows/toRunTimelineRows attach (not part of the
 *  library's own TimelineAction type, which is why the cast below is needed) — liveState is
 *  undefined in Compose's edit mode, where every Load is equally "current". */
export function renderAction(rawAction: TimelineAction) {
  const action = rawAction as ActionWithShape;
  const visual = getShapeVisual(action.shape);
  const { Glyph } = visual;
  const opacity = action.liveState ? LIVE_STATE_OPACITY[action.liveState] : 1;
  const color = action.trackColor;
  const bg = trackColorBg(color);

  return (
    <div
      className="flex h-full w-full items-center gap-1.5 rounded border px-1.5 text-[13px] font-medium transition-opacity"
      style={{
        backgroundColor: bg,
        borderColor: color,
        color,
        opacity,
        // Accent-colored ring rather than a white one — a white ring disappears against light
        // backgrounds, and every track color needs to keep working in both themes. Also used to
        // call out the currently-active Load on the Run screen.
        boxShadow: action.selected || action.liveState === "active" ? "0 0 0 2px var(--color-accent)" : undefined,
      }}
      title={`${visual.label}${visual.detail ? ` — ${visual.detail}` : ""}`}
    >
      <Glyph className="h-3 w-3 shrink-0" />
      {/* Deliberately not `truncate`: the colored box stays sized to the Load's real duration
       *  (set by the library via absolute positioning), but the label/detail text is allowed to
       *  spill past its right edge uncut rather than ellipsize — legible beats contained. The
       *  matching opaque background here (rather than transparent text) means that when two
       *  short blocks sit right next to each other (e.g. a Ramp up immediately followed by a Ramp
       *  down), the later one — later in the DOM, so it paints on top — cleanly covers the
       *  earlier one's overflow instead of interleaving into unreadable overlapping text. */}
      <div className="rounded pr-1 leading-tight" style={{ backgroundColor: bg }}>
        <div className="whitespace-nowrap">{visual.label}</div>
        {visual.detail && <div className="whitespace-nowrap text-[11px] opacity-75">{visual.detail}</div>}
      </div>
    </div>
  );
}
