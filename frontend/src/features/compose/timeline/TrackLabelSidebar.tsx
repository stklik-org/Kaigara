import { useRef, useState, type DragEvent, type RefObject } from "react";
import type { Track } from "@kaigara/shared-types";
import { useScenarioStore } from "../store/scenarioStore";
import { createTrack } from "./modelFactories";
import { SIDEBAR_WIDTH_DEFAULT } from "./timelineConstants";
import { trackColorLookup } from "./trackColors";

function TrackColorSwatch({ trackId, color }: { trackId: string; color: string }) {
  const recolorTrack = useScenarioStore((s) => s.recolorTrack);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    // `flex` (not just block) so the swatch button isn't laid out in a ~30px inherited line-box,
    // which otherwise inflated this wrapper and pushed the row's delete button out of alignment.
    <div className="relative flex flex-none">
      <button
        type="button"
        title="Pick track color"
        className="h-3.5 w-3.5 flex-none rounded-sm border border-black/20"
        style={{ backgroundColor: color }}
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="color"
        value={color}
        onChange={(e) => recolorTrack(trackId, e.target.value)}
        className="pointer-events-none absolute top-0 left-0 h-0 w-0 opacity-0"
        tabIndex={-1}
      />
    </div>
  );
}

/** Deleting a track with Loads on it asks first — the row turns into its own confirmation, rather
 *  than opening a dialog over a canvas the user is mid-thought in. */
function DeleteTrackButton({ track, onDelete }: { track: Track; onDelete: () => void }) {
  return (
    <button
      type="button"
      onClick={onDelete}
      title="Delete track"
      className="flex h-4 w-4 items-center justify-center rounded text-[14px] leading-none text-ink-muted hover:bg-status-fail-bg hover:text-status-fail"
      aria-label={`Delete track ${track.label}`}
    >
      ×
    </button>
  );
}

function ReorderButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`Move track ${direction}`}
      className="flex h-4 w-4 items-center justify-center text-[11px] text-ink-muted hover:text-ink disabled:opacity-25 disabled:hover:text-ink-muted"
    >
      {direction === "up" ? "▲" : "▼"}
    </button>
  );
}

function TrackLabelRow({
  track,
  color,
  rowHeight,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  track: Track;
  color: string;
  rowHeight: number;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const renameTrack = useScenarioStore((s) => s.renameTrack);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.label);
  const [confirming, setConfirming] = useState(false);

  function commitRename() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== track.label) {
      renameTrack(track.id, trimmed);
    } else {
      setDraft(track.label);
    }
  }

  if (confirming) {
    return (
      <div
        style={{ height: rowHeight }}
        className="flex flex-col items-start justify-center gap-1.5 border-b border-border bg-status-fail-bg px-3"
      >
        <span className="text-[11px] font-medium text-status-fail">Delete "{track.label}"?</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
            className="rounded border border-status-fail bg-status-fail px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-80"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: rowHeight }} className="flex items-center gap-1.5 border-b border-border px-3">
      {/* Left column: colour swatch over the delete button. A compact, vertically-centred cluster —
          `self-stretch justify-between` used to spread these across the row, but the two controls
          are together taller than the row minus its padding, so the × spilled into the row below. */}
      <div className="flex flex-none flex-col items-center gap-1">
        <TrackColorSwatch trackId={track.id} color={color} />
        <DeleteTrackButton
          track={track}
          onDelete={() => (track.loads.length === 0 ? onDelete() : setConfirming(true))}
        />
      </div>

      {/* Centre: the label, which is also the drag handle for reordering. */}
      <div
        draggable={!editing}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        title="Drag to reorder"
        className={`min-w-0 flex-1 cursor-grab truncate active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
      >
        {editing ? (
          // Same transparent/hover/focus treatment as ComposePage's ScenarioNameField — a track
          // title is renamed the same way the scenario itself is, so it should look like it.
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(track.label);
                setEditing(false);
              }
            }}
            className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs font-medium text-ink outline-none hover:border-border-strong focus:border-accent focus:bg-surface"
          />
        ) : (
          <div>
            {/* Not an <input> at rest — this span is also the drag handle (draggable sits on its
                parent), and a native drag won't start off a mousedown that lands on an editable
                text field. Bordered/hover-highlighted the same way regardless, so double-clicking
                to rename reads as "opening" this exact box rather than a different affordance. */}
            <span
              className="block truncate rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium text-ink transition-colors hover:border-border-strong"
              onDoubleClick={() => setEditing(true)}
            >
              {track.label}
            </span>
            <span className="truncate px-1.5 text-[11px] text-ink-muted">
              {track.loads.length} load{track.loads.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-none flex-col">
        <ReorderButton direction="up" disabled={!canMoveUp} onClick={onMoveUp} />
        <ReorderButton direction="down" disabled={!canMoveDown} onClick={onMoveDown} />
      </div>
    </div>
  );
}

/** The label column TimelineView renders alongside <Timeline> (the library has no concept of a
 *  track label column at all). Double-click a title to rename it; drag a title onto another
 *  track's title, or use the ▲/▼ buttons, to reorder — both scoped to the label specifically, not
 *  the whole row. Click the colour swatch to open a colour picker. "+ Add track" appends an empty
 *  Track with an auto-assigned palette colour.
 *
 *  Alignment note: this mirrors the library's own DOM structure — a fixed header div whose height
 *  matches the library's time-area header, followed by an `overflow-y: hidden` rows container
 *  whose scrollTop is driven imperatively by TimelineView (via `scrollRef`) to stay pixel-locked
 *  with the library's virtualized grid on every scroll event. */
export function TrackLabelSidebar({
  tracks,
  rowHeight,
  timeAreaHeight,
  scrollRef,
  width = SIDEBAR_WIDTH_DEFAULT,
}: {
  tracks: Track[];
  rowHeight: number;
  timeAreaHeight: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Column width in px — user-resizable, owned by ComposePage. */
  width?: number;
}) {
  const reorderTracks = useScenarioStore((s) => s.reorderTracks);
  const addTrack = useScenarioStore((s) => s.addTrack);
  const removeTrack = useScenarioStore((s) => s.removeTrack);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const colorOf = trackColorLookup(tracks);

  return (
    <div className="flex flex-none flex-col border-r border-border bg-surface" style={{ width }}>
      {/* Mirrors .timeline-editor-time-area — same height, same border-bottom, so every track row
          below is pixel-aligned with the library's own rows. */}
      <div className="flex-none border-b border-border bg-surface-sunken" style={{ height: timeAreaHeight }} />
      {/* overflow-y: hidden so the library's scrollTop can be mirrored here imperatively without
          showing a second scrollbar. */}
      <div ref={scrollRef} className="flex-1 overflow-y-hidden">
        {tracks.map((track, index) => (
          <TrackLabelRow
            key={track.id}
            track={track}
            color={colorOf(track.id)}
            rowHeight={rowHeight}
            isDragging={dragIndex === index}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null && dragIndex !== index) reorderTracks(dragIndex, index);
              setDragIndex(null);
            }}
            canMoveUp={index > 0}
            canMoveDown={index < tracks.length - 1}
            onMoveUp={() => reorderTracks(index, index - 1)}
            onMoveDown={() => reorderTracks(index, index + 1)}
            onDelete={() => removeTrack(track.id)}
          />
        ))}
        <button
          type="button"
          onClick={() => addTrack(createTrack())}
          title="Add a new track"
          className="flex w-full items-center justify-center gap-1 border-b border-border py-2 text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          <span className="text-sm leading-none">+</span>
          <span className="text-xs">Add track</span>
        </button>
      </div>
    </div>
  );
}
