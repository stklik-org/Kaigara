import { useRef, useState, type DragEvent } from "react";
import type React from "react";
import { Track } from "@kaigara/shared-types";
import { useScenarioStore } from "../store/scenarioStore";
import { resolveTrackColors } from "./shapeVisuals";

let nextTrackSuffix = 1;

function TrackColorSwatch({ track, color }: { track: Track; color: string }) {
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
        onChange={(e) => recolorTrack(track.id, e.target.value)}
        className="pointer-events-none absolute left-0 top-0 h-0 w-0 opacity-0"
        tabIndex={-1}
      />
    </div>
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

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== track.label) {
      renameTrack(track.id, trimmed);
    } else {
      setDraft(track.label);
    }
  }

  function handleDeleteClick() {
    if (track.loads.length === 0) {
      onDelete();
    } else {
      setConfirming(true);
    }
  }

  if (confirming) {
    return (
      <div
        style={{ height: rowHeight }}
        className="flex flex-col items-start justify-center gap-1.5 border-b border-border bg-status-fail-bg px-3"
      >
        <span className="text-[11px] font-medium text-status-fail">
          Delete "{track.label}"?
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => { setConfirming(false); onDelete(); }}
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
    <div style={{ height: rowHeight }} className="flex items-center border-b border-border px-3 gap-1.5">
      {/* Left column: color swatch on top, delete button below. A compact, vertically-centred
       *  cluster — `self-stretch justify-between` used to spread these across the row, but the two
       *  controls are together taller than the 44px row minus padding, so the × spilled ~10px into
       *  the row below. */}
      <div className="flex flex-none flex-col items-center gap-1">
        <TrackColorSwatch track={track} color={color} />
        <button
          type="button"
          onClick={handleDeleteClick}
          title="Delete track"
          className="flex h-4 w-4 items-center justify-center rounded text-[14px] leading-none text-ink-muted hover:bg-status-fail-bg hover:text-status-fail"
        >
          ×
        </button>
      </div>

      {/* Centre: label (draggable) */}
      <div
        draggable={!editing}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        title="Drag to reorder"
        className={`min-w-0 flex-1 cursor-grab truncate active:cursor-grabbing ${isDragging ? "opacity-40" : ""}`}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(track.label);
                setEditing(false);
              }
            }}
            className="w-full bg-transparent text-xs font-medium text-ink outline-none"
          />
        ) : (
          <div>
            <span className="block truncate text-xs font-medium text-ink" onDoubleClick={() => setEditing(true)}>
              {track.label}
            </span>
            <span className="truncate text-[11px] text-ink-muted">
              {track.loads.length} load{track.loads.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>

      {/* Right column: reorder buttons */}
      <div className="flex flex-none flex-col">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          title="Move track up"
          className="flex h-4 w-4 items-center justify-center text-[11px] text-ink-muted hover:text-ink disabled:opacity-25 disabled:hover:text-ink-muted"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          title="Move track down"
          className="flex h-4 w-4 items-center justify-center text-[11px] text-ink-muted hover:text-ink disabled:opacity-25 disabled:hover:text-ink-muted"
        >
          ▼
        </button>
      </div>
    </div>
  );
}

/** The label column TimelineView renders alongside <Timeline> (the library has no concept of a
 *  track label column at all). Double-click a title to rename it; drag a title onto another
 *  track's title, or use the ▲/▼ buttons, to reorder — both scoped to the label part
 *  specifically, not the whole row. Click the color swatch to open a color picker. "+ Add track"
 *  appends a new empty Track at the bottom with an auto-assigned palette color.
 *
 *  Alignment note: the sidebar mirrors the library's own DOM structure — a fixed header div whose
 *  height matches the library's time-area header, followed by a `overflow-y: hidden` rows
 *  container whose scrollTop is driven imperatively by TimelineView (via scrollRef) to stay
 *  pixel-locked with the library's virtualized grid on every scroll event. */
export function TrackLabelSidebar({
  tracks,
  rowHeight,
  timeAreaHeight,
  scrollRef,
  width = 180,
}: {
  tracks: Track[];
  rowHeight: number;
  timeAreaHeight: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Column width in px — user-resizable, owned by ComposePage (default matches the old `w-36`). */
  width?: number;
}) {
  const reorderTracks = useScenarioStore((s) => s.reorderTracks);
  const addTrack = useScenarioStore((s) => s.addTrack);
  const removeTrack = useScenarioStore((s) => s.removeTrack);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const trackColors = resolveTrackColors(tracks);

  return (
    <div className="flex flex-none flex-col border-r border-border bg-surface" style={{ width }}>
      {/* Mirrors .timeline-editor-time-area — same height, same border-bottom, so every track
       *  row below this header is pixel-aligned with the library's own rows. */}
      <div
        className="flex-none border-b border-border bg-surface-sunken"
        style={{ height: timeAreaHeight }}
      />
      {/* overflow-y: hidden so the library's scrollTop can be mirrored here imperatively
       *  (via scrollRef) without showing a second scrollbar on the sidebar. */}
      <div ref={scrollRef} className="flex-1 overflow-y-hidden">
        {tracks.map((track, index) => (
          <TrackLabelRow
            key={track.id}
            track={track}
            color={trackColors.get(track.id)!}
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
          onClick={() =>
            addTrack(
              new Track({
                id: `track-${Date.now()}-${nextTrackSuffix++}`,
                label: "New track",
                loads: [],
              }),
            )
          }
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
