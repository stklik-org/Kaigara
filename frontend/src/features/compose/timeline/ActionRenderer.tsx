import type { CSSProperties } from "react";
import type { TimelineAction } from "@xzdarcy/timeline-engine";
import { getShapeVisual } from "./shapeVisuals";
import { trackColorBg, trackColorChipBg } from "./trackColors";
import type { LiveState, LoadAction } from "./timelineAdapters";

const LIVE_STATE_OPACITY: Record<LiveState, number> = {
  past: 0.35,
  active: 1,
  future: 0.75,
};

/** `getActionRender` for <Timeline>. The library renders this inside its own absolutely-positioned
 *  `.timeline-editor-action` box, so this only has to fill that box with our glyph/label/colour.
 *
 *  The cast is the seam with the library's type: `shape`, `trackColor` and `liveState` are our own
 *  fields, attached by the adapters and passed straight back here untouched. `liveState` is absent
 *  in Compose's edit mode, where every Load is equally "current". */
export function renderAction(rawAction: TimelineAction) {
  const action = rawAction as LoadAction;
  const { Glyph, label, detail } = getShapeVisual(action.shape);
  const color = action.trackColor;
  const background = trackColorBg(color);
  const chipBackground = trackColorChipBg(color);

  return (
    <div
      className="flex h-full w-full items-center gap-1.5 rounded border px-1.5 text-[13px] font-medium transition-opacity transition-shadow hover:border-2"
      style={{
        backgroundColor: background,
        borderColor: color,
        color,
        opacity: action.liveState ? LIVE_STATE_OPACITY[action.liveState] : 1,
        // An accent ring rather than a white one: white disappears against light backgrounds, and
        // every track colour has to keep working in both themes. Also marks the Load the Run
        // screen's playhead is currently inside.
        boxShadow: action.selected || action.liveState === "active" ? "0 0 0 2px var(--color-accent)" : undefined,
      }}
      title={`${label}${detail ? ` — ${detail}` : ""}`}
    >
      {/* Glyph + label carry no fill of their own at rest — just the Load's own ≈18%-alpha
          background shows through, so the chip doesn't read as a second nested box. Its opaque
          chip colour is only exposed via timeline-theme.css's `.timeline-editor-action:hover
          .action-chip` rule (set here as a CSS variable, since the colour is per-track and a
          plain class can't carry it), so hovering a Load both brings it in front of an overlapping
          neighbour and gives its icon+label a solid backdrop to read against — exactly when you're
          trying to inspect one. Deliberately not `truncate`: the chip is sized to its content, but
          the label is allowed to spill past the Load's own right edge uncut rather than ellipsize
          — legible beats contained. */}
      <div
        className="action-chip flex shrink-0 items-center gap-1.5 rounded pr-1 leading-tight transition-colors"
        style={{ "--action-chip-bg": chipBackground } as CSSProperties}
      >
        <Glyph className="h-3 w-3 shrink-0" />
        <div>
          <div className="whitespace-nowrap">{label}</div>
          {detail && <div className="whitespace-nowrap text-[11px] opacity-75">{detail}</div>}
        </div>
      </div>
    </div>
  );
}
