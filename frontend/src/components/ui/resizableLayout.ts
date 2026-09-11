import type { ReactNode } from "react";
import { readJson } from "@/lib/storage";

/**
 * The sizing model shared by {@link ResizableRows} and {@link ResizableColumns}.
 *
 * Nothing in here is about an axis: it resolves a list of panes — each with a minimum, an optional
 * maximum and default, and exactly one marked `flex` — to whole-pixel sizes that together fill a
 * container exactly, and it applies a divider drag. Rows call the numbers heights and columns call
 * them widths; the arithmetic is identical, so it lives in one place.
 */

/** One row in a {@link ResizableRows} stack.
 *
 *  Sizing model: every row except the `flex` one is laid out at an explicit pixel height
 *  (`overrides[key]` once dragged, otherwise `defaultHeight`, otherwise `minHeight`, all clamped
 *  to `[minHeight, maxHeight]`). The single `flex` row absorbs whatever height is left over — and
 *  therefore also absorbs window resizes, sibling collapse, and sub-pixel rounding, so it never
 *  leaves a seam. Drag handles sit between rows and move the shared boundary in raw pixels; there
 *  is no snapping. */
export interface ResizableRow {
  key: string;
  /** Smallest height this row may be dragged to, px. Also the height it is pinned at when the
   *  `flex` row runs out of room and has to steal space back. */
  minHeight: number;
  /** Largest height this row may be dragged to, px. Unbounded when omitted. Ignored for the
   *  `flex` row. */
  maxHeight?: number;
  /** Height to use before the row has ever been dragged (and when nothing valid is restored from
   *  `storageKey`). Defaults to `minHeight`. Ignored for the `flex` row. */
  defaultHeight?: number;
  /** Share of the container to open at, 0–1, when there is no `defaultHeight` and nothing has been
   *  dragged — for panes whose natural size is "a quarter of whatever room there is" rather than a
   *  fixed number of pixels. Still clamped by `minHeight`/`maxHeight`, and only ever a *default*:
   *  once dragged, the stored pixel size wins and the pane stops re-proportioning on resize. */
  defaultFraction?: number;
  /** Marks the row that soaks up leftover space. Exactly one row should set this; if none does,
   *  the last row is used. */
  flex?: boolean;
  /** When set, the row is pinned to exactly this height and the handle directly above it is
   *  inert — used to render a collapsed row as a thin strip. `render` is still called (so the
   *  strip can show its own "expand" affordance). */
  collapsedHeight?: number;
  /** Accessible name for the resize handle rendered directly *above* this row. */
  handleLabel?: string;
  /** Row body. Receives its own resolved pixel height, for children (e.g. a virtualized
   *  timeline) that need an explicit number rather than `height: 100%`. */
  render: (height: number) => ReactNode;
}

/** Grab-strip height. Kept slim — the resting divider is a 1px hairline centred in it; the strip
 *  itself is just the (invisible) hit target.
 *
 *  The sizing maths below (`computeLayout`, `applyDivider`, `readStored`) is exported because it is
 *  about *sizes*, not about the vertical axis: {@link ResizableColumns} in `ResizableColumns.tsx`
 *  drives its widths through exactly these functions, so there is one splitter implementation. */
export const HANDLE_PX = 7;
export const KEYBOARD_STEP_PX = 12;
export const KEYBOARD_STEP_PX_COARSE = 48;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(value, Math.max(lo, hi)));

function flexRowOf(rows: ResizableRow[]): ResizableRow {
  return rows.find((r) => r.flex) ?? rows[rows.length - 1];
}

/** Resolves every row to a whole-pixel height that together exactly fill `containerHeight`.
 *  Pure — called once per render; cheap enough not to memoize for the handful of rows this is
 *  ever used with. */
export function computeLayout(
  rows: ResizableRow[],
  containerHeight: number,
  overrides: Record<string, number>,
): Record<string, number> {
  const flexRow = flexRowOf(rows);
  const available = Math.max(0, containerHeight - (rows.length - 1) * HANDLE_PX);
  const resolved: Record<string, number> = {};

  for (const row of rows) {
    if (row.key === flexRow.key) continue;
    if (row.collapsedHeight != null) {
      resolved[row.key] = row.collapsedHeight;
      continue;
    }
    const proportional = row.defaultFraction != null ? row.defaultFraction * available : undefined;
    const desired = overrides[row.key] ?? row.defaultHeight ?? proportional ?? row.minHeight;
    resolved[row.key] = clamp(desired, row.minHeight, row.maxHeight ?? available);
  }

  const fixedTotal = () => rows.reduce((sum, r) => (r.key === flexRow.key ? sum : sum + resolved[r.key]), 0);
  let flexHeight = available - fixedTotal();

  // Not enough room for the flex row at its minimum: claw space back from the fixed rows that
  // still have slack above their own minimum, proportionally to how much slack each has.
  if (flexHeight < flexRow.minHeight) {
    const shrinkable = rows.filter(
      (r) => r.key !== flexRow.key && r.collapsedHeight == null && resolved[r.key] > r.minHeight,
    );
    const totalSlack = shrinkable.reduce((sum, r) => sum + (resolved[r.key] - r.minHeight), 0);
    if (totalSlack > 0) {
      const take = Math.min(flexRow.minHeight - flexHeight, totalSlack);
      for (const row of shrinkable) {
        resolved[row.key] -= ((resolved[row.key] - row.minHeight) / totalSlack) * take;
      }
    }
    flexHeight = available - fixedTotal();
  }
  resolved[flexRow.key] = Math.max(0, flexHeight);

  // Round fixed rows to whole pixels and let the flex row swallow the remainder, so the stack
  // still sums to `available` exactly (no 1px seam from accumulated fractions).
  let acc = 0;
  for (const row of rows) {
    if (row.key === flexRow.key) continue;
    resolved[row.key] = Math.round(resolved[row.key]);
    acc += resolved[row.key];
  }
  resolved[flexRow.key] = Math.max(0, available - acc);
  return resolved;
}

/** Applies a divider drag: the boundary between `rows[i]` and `rows[i + 1]` moves by `dy` px
 *  (positive = downward). Only ever returns *fixed*-row heights — the flex row re-derives in
 *  {@link computeLayout}. The non-flex side is clamped so the flex row on the other side can't be
 *  pushed below its own minimum. */
export function applyDivider(
  rows: ResizableRow[],
  i: number,
  startHeights: Record<string, number>,
  dy: number,
): Record<string, number> {
  const a = rows[i];
  const b = rows[i + 1];
  const aMax = a.maxHeight ?? Infinity;
  const bMax = b.maxHeight ?? Infinity;

  if (b.flex) {
    const room = startHeights[a.key] + startHeights[b.key] - b.minHeight;
    return { [a.key]: clamp(startHeights[a.key] + dy, a.minHeight, Math.min(aMax, room)) };
  }
  if (a.flex) {
    const room = startHeights[a.key] + startHeights[b.key] - a.minHeight;
    return { [b.key]: clamp(startHeights[b.key] - dy, b.minHeight, Math.min(bMax, room)) };
  }
  const nextA = clamp(
    startHeights[a.key] + dy,
    a.minHeight,
    Math.min(aMax, startHeights[a.key] + startHeights[b.key] - b.minHeight),
  );
  return { [a.key]: nextA, [b.key]: startHeights[b.key] - (nextA - startHeights[a.key]) };
}

const isHeightMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Restores dragged heights, keeping only the keys this stack actually has as fixed rows — a
 *  layout that has since gained, lost or renamed a row must not resurrect a stale entry. */
export function readStored(storageKey: string | undefined, rows: ResizableRow[]): Record<string, number> {
  if (!storageKey) return {};
  const stored = readJson(storageKey, isHeightMap);
  if (!stored) return {};
  const fixedKeys = new Set(rows.filter((r) => !r.flex).map((r) => r.key));
  return Object.fromEntries(
    Object.entries(stored).filter(([k, v]) => fixedKeys.has(k) && typeof v === "number" && Number.isFinite(v)),
  ) as Record<string, number>;
}

