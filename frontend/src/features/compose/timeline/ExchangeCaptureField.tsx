import type { ExchangeCaptureMode } from "@kaigara/shared-types";
import { useScenarioStore } from "../store/scenarioStore";

const MODES: { value: ExchangeCaptureMode; label: string; hint: string }[] = [
  { value: "capped", label: "64 KB cap", hint: "Every request and response, each body cut at 64 KB." },
  {
    value: "capped-sampled",
    label: "64 KB cap + sampled complete",
    hint: "Every exchange cut at 64 KB, except a sample kept complete — errors first, then an even spread of successes.",
  },
  { value: "complete", label: "All complete", hint: "Every body in full. The load generator pays for it in CPU and disk while the run is live." },
];

/** The timeline toolbar's "Exchange capture" setting, bound to `LoadTimeline.capture`: how much of
 *  each request/response a run keeps in its log folder for the Run screen's popup. */
export function ExchangeCaptureField() {
  const capture = useScenarioStore((s) => s.timeline.capture);
  const setCapture = useScenarioStore((s) => s.setCapture);
  const mode = capture?.mode ?? "capped";
  const storeAllErrors = capture?.storeAllErrors === true;

  function update(nextMode: ExchangeCaptureMode, nextStoreAllErrors: boolean) {
    // "All complete" already keeps every error; and the default is left out of the document, so a
    // scenario that never chose a capture setting stays byte-identical.
    const errors = nextMode !== "complete" && nextStoreAllErrors;
    setCapture(nextMode === "capped" && !errors ? undefined : { mode: nextMode, ...(errors ? { storeAllErrors: true } : {}) });
  }

  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-muted">
      <label className="flex items-center gap-1.5" title={MODES.find((m) => m.value === mode)?.hint}>
        <span>Exchange capture</span>
        <select
          value={mode}
          onChange={(event) => update(event.target.value as ExchangeCaptureMode, storeAllErrors)}
          className="rounded border border-border-strong bg-transparent px-1 py-0.5 text-ink outline-none focus:border-accent"
        >
          {MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label
        className={`flex items-center gap-1 ${mode === "complete" ? "opacity-50" : ""}`}
        title="Keep every error (any status outside 2xx) complete, whatever the cap or sample."
      >
        <input
          type="checkbox"
          checked={storeAllErrors || mode === "complete"}
          disabled={mode === "complete"}
          onChange={(event) => update(mode, event.target.checked)}
        />
        <span>Store all errors in full</span>
      </label>
    </div>
  );
}
