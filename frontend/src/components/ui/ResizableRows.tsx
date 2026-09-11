import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  applyDivider,
  computeLayout,
  readStored,
  HANDLE_PX,
  KEYBOARD_STEP_PX,
  KEYBOARD_STEP_PX_COARSE,
  type ResizableRow,
} from "@/components/ui/resizableLayout";
import { writeJson } from "@/lib/storage";

export type { ResizableRow };

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
    if (storageKey) writeJson(storageKey, overrides);
  }, [overrides, storageKey]);

  const resolved = computeLayout(rows, containerHeight, overrides);
  // Nothing is rendered until the container has been measured. `useLayoutEffect` measures before
  // the browser paints, so this costs no visible frame — and it means a row body always *mounts*
  // at its real height. A child that reads its own box once on mount (react-virtualized inside the
  // timeline does exactly that) would otherwise cache a height of 0 and render an empty grid.
  const measured = containerHeight > 0;

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
      {measured &&
        rows.map((row, i) => {
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
