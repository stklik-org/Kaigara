import { SCALE_WIDTH_MAX, SCALE_WIDTH_MIN, SCALE_WIDTH_STEP } from "./timelineConstants";

const BUTTON_CLASS =
  "flex h-6 w-6 items-center justify-center rounded border border-border-strong text-ink-muted hover:text-ink";

/** The −/+ zoom pair above a timeline. `scaleWidth` is the px width of one major tick (a minute),
 *  which is the single knob both timeline views expose; clamping lives here so the Compose and Run
 *  screens cannot end up with different limits. */
export function ZoomControl({
  scaleWidth,
  onChange,
}: {
  scaleWidth: number;
  onChange: (scaleWidth: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="ml-1 text-[12px] text-ink-muted">Zoom</span>
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => onChange(Math.max(SCALE_WIDTH_MIN, scaleWidth - SCALE_WIDTH_STEP))}
        className={BUTTON_CLASS}
      >
        −
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => onChange(Math.min(SCALE_WIDTH_MAX, scaleWidth + SCALE_WIDTH_STEP))}
        className={BUTTON_CLASS}
      >
        +
      </button>
    </div>
  );
}
