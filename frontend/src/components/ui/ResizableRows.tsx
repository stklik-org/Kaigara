import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

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
 *  itself is just the (invisible) hit target. */
const HANDLE_PX = 7;
const KEYBOARD_STEP_PX = 12;
const KEYBOARD_STEP_PX_COARSE = 48;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(value, Math.max(lo, hi)));

function flexRowOf(rows: ResizableRow[]): ResizableRow {
  return rows.find((r) => r.flex) ?? rows[rows.length - 1];
}

/** Resolves every row to a whole-pixel height that together exactly fill `containerHeight`.
 *  Pure — called once per render; cheap enough not to memoize for the handful of rows this is
 *  ever used with. */
function computeLayout(
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
    const desired = overrides[row.key] ?? row.defaultHeight ?? row.minHeight;
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
function applyDivider(
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

function readStored(storageKey: string | undefined, rows: ResizableRow[]): Record<string, number> {
  if (!storageKey) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    const fixedKeys = new Set(rows.filter((r) => !r.flex).map((r) => r.key));
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => fixedKeys.has(k) && typeof v === "number" && Number.isFinite(v)),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** A vertical stack of panes with draggable dividers between them. Pixel-precise (no row-height
 *  quantization), keyboard-resizable, and self-correcting on container resize — one `flex` row
 *  always absorbs the leftover so the panes together fill the height exactly. Optionally persists
 *  the dragged sizes to `localStorage` under `storageKey`. */
export function ResizableRows({
  rows,
  storageKey,
  className = "",
}: {
  rows: ResizableRow[];
  storageKey?: string;
  className?: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, number>>(() => readStored(storageKey, rows));
  const dragRef = useRef<{ handleIndex: number; startY: number; startHeights: Record<string, number> } | null>(null);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => setContainerHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {
      /* private mode / quota — sizing still works this session, just isn't remembered */
    }
  }, [overrides, storageKey]);

  const resolved = computeLayout(rows, containerHeight, overrides);

  // Recompute the live layout from `prev` inside the updater rather than closing over `resolved`,
  // so a burst of keypresses in one tick accumulates instead of all resolving off the same frame.
  function nudge(handleIndex: number, dy: number) {
    setOverrides((prev) => ({
      ...prev,
      ...applyDivider(rows, handleIndex, computeLayout(rows, containerHeight, prev), dy),
    }));
  }

  function beginDrag(handleIndex: number, e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragRef.current = { handleIndex, startY: e.clientY, startHeights: { ...resolved } };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no live pointer for this id (e.g. synthetic event) — drag still tracks via React events */
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  }

  function onDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setOverrides((prev) => ({
      ...prev,
      ...applyDivider(rows, drag.handleIndex, drag.startHeights, e.clientY - drag.startY),
    }));
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  function onHandleKeyDown(handleIndex: number, e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? KEYBOARD_STEP_PX_COARSE : KEYBOARD_STEP_PX;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      nudge(handleIndex, -step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nudge(handleIndex, step);
    }
  }

  return (
    <div ref={outerRef} className={`flex min-h-0 flex-col overflow-hidden ${className}`}>
      {rows.map((row, i) => {
        const height = resolved[row.key] ?? 0;
        // Handle i - 1 sits above this row; it's inert next to a collapsed pane on either side.
        const handleIndex = i - 1;
        const handleActive =
          i > 0 && rows[handleIndex].collapsedHeight == null && row.collapsedHeight == null;

        return (
          <Fragment key={row.key}>
            {i > 0 && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={row.handleLabel ?? `Resize ${rows[handleIndex].key} / ${row.key} panels`}
                aria-valuenow={Math.round(resolved[rows[handleIndex].key] ?? 0)}
                tabIndex={handleActive ? 0 : -1}
                onPointerDown={handleActive ? (e) => beginDrag(handleIndex, e) : undefined}
                onPointerMove={handleActive ? onDrag : undefined}
                onPointerUp={handleActive ? endDrag : undefined}
                onPointerCancel={handleActive ? endDrag : undefined}
                onKeyDown={handleActive ? (e) => onHandleKeyDown(handleIndex, e) : undefined}
                style={{ height: HANDLE_PX }}
                className={`group relative shrink-0 ${
                  handleActive ? "cursor-row-resize touch-none focus-visible:outline-none" : ""
                }`}
              >
                {/* Resting state: a 1px hairline. Active + hover/focus: it thickens to an accent
                    line. No slab, no grip pill — the cursor change is the affordance. */}
                <div
                  className={`pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-border transition-colors ${
                    handleActive ? "group-hover:border-accent group-focus-visible:border-accent" : ""
                  }`}
                />
                {handleActive && (
                  <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                )}
              </div>
            )}
            <div className="min-h-0 shrink-0 overflow-hidden" style={{ height }}>
              {row.render(height)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
