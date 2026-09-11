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

/** One column in a {@link ResizableColumns} row. Same sizing model as {@link ResizableRow}, turned
 *  ninety degrees: every column but the single `flex` one is laid out at an explicit pixel width,
 *  and the flex column absorbs whatever is left (and therefore window resizes too). */
export interface ResizableColumn {
  key: string;
  minWidth: number;
  maxWidth?: number;
  defaultWidth?: number;
  /** Share of the row to open at, 0–1 — see {@link ResizableRow.defaultFraction}. */
  defaultFraction?: number;
  flex?: boolean;
  /** Accessible name for the resize handle rendered directly *before* this column. */
  handleLabel?: string;
  render: (width: number) => ReactNode;
}

/** The layout maths is about sizes, not about an axis, so it is shared with ResizableRows rather
 *  than restated here — only the chrome (cursor, borders, arrow keys, style property) differs. */
function asRows(columns: ResizableColumn[]): ResizableRow[] {
  return columns.map((column) => ({
    key: column.key,
    minHeight: column.minWidth,
    maxHeight: column.maxWidth,
    defaultHeight: column.defaultWidth,
    defaultFraction: column.defaultFraction,
    flex: column.flex,
    render: () => null,
  }));
}

/** A horizontal row of panes with draggable dividers between them — the sibling of
 *  {@link ResizableRows}, used for the Compose info row's Load shape / composition / catalogue
 *  columns. Persists dragged widths to `localStorage` under `storageKey`. */
export function ResizableColumns({
  columns,
  storageKey,
  className = "",
}: {
  columns: ResizableColumn[];
  storageKey?: string;
  className?: string;
}) {
  const rows = asRows(columns);
  const outerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, number>>(() => readStored(storageKey, rows));
  const dragRef = useRef<{ handleIndex: number; startX: number; startWidths: Record<string, number> } | null>(null);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (storageKey) writeJson(storageKey, overrides);
  }, [overrides, storageKey]);

  const resolved = computeLayout(rows, containerWidth, overrides);
  const measured = containerWidth > 0;

  function nudge(handleIndex: number, dx: number) {
    setOverrides((prev) => ({
      ...prev,
      ...applyDivider(rows, handleIndex, computeLayout(rows, containerWidth, prev), dx),
    }));
  }

  function beginDrag(handleIndex: number, e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    dragRef.current = { handleIndex, startX: e.clientX, startWidths: { ...resolved } };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no live pointer for this id (e.g. synthetic event) — drag still tracks via React events */
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function onDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setOverrides((prev) => ({
      ...prev,
      ...applyDivider(rows, drag.handleIndex, drag.startWidths, e.clientX - drag.startX),
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
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(handleIndex, -step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nudge(handleIndex, step);
    }
  }

  return (
    <div ref={outerRef} className={`flex min-w-0 flex-row overflow-hidden ${className}`}>
      {measured &&
        columns.map((column, i) => {
          const width = resolved[column.key] ?? 0;
          const handleIndex = i - 1;

          return (
            <Fragment key={column.key}>
              {i > 0 && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={column.handleLabel ?? `Resize ${columns[handleIndex].key} / ${column.key} panels`}
                  aria-valuenow={Math.round(resolved[columns[handleIndex].key] ?? 0)}
                  tabIndex={0}
                  onPointerDown={(e) => beginDrag(handleIndex, e)}
                  onPointerMove={onDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={(e) => onHandleKeyDown(handleIndex, e)}
                  style={{ width: HANDLE_PX }}
                  className="group relative shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
                >
                  <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 border-l border-border transition-colors group-hover:border-accent group-focus-visible:border-accent" />
                  <div className="pointer-events-none absolute top-1/2 left-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </div>
              )}
              <div className="min-w-0 shrink-0 overflow-hidden" style={{ width }}>
                {column.render(width)}
              </div>
            </Fragment>
          );
        })}
    </div>
  );
}
