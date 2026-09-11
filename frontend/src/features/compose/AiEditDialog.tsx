import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { LlmSettingsDialog } from "@/features/load/LlmSettingsDialog";
import { isLlmConfigReady, loadLlmConfig } from "@/lib/assist/llmConfig";
import { providerDef } from "@/lib/assist/llmProviders";

/**
 * The popup behind Compose's "edit with AI" button: describe a change to the current timeline in
 * plain language, and the configured model returns the whole updated document (validated the same
 * way a Code-view edit is before it reaches the store).
 *
 * Provider setup is reachable from here too — the gear opens the same `LlmSettingsDialog` the Load
 * screen uses, stacked over this one — so the whole flow works without leaving Compose.
 */
const TEXTAREA_CLASS =
  "w-full resize-y rounded border border-field-border bg-field px-2 py-1.5 text-sm text-ink outline-none focus:border-accent";

const EXAMPLE_EDITS = [
  "Add a 5-minute warm-up ramp from 0 up to the first load's rate, before it starts.",
  "Double every request rate across all tracks.",
  "Add a spike of 1000 requests per second halfway through the run.",
  "Add a second track that queries the shell collection at 50 req/s for the whole run.",
];

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
    </svg>
  );
}

export function AiEditDialog({
  onClose,
  onApply,
}: {
  onClose: () => void;
  /** Runs the edit against the current timeline. Resolves once the store has been updated;
   *  rejects with a message safe to show verbatim. */
  onApply: (instruction: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState(loadLlmConfig);

  const trimmed = instruction.trim();
  const ready = isLlmConfigReady(config);
  const providerLabel = providerDef(config.provider).label;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !settingsOpen) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, settingsOpen]);

  async function apply() {
    setError(null);
    if (!ready) {
      setSettingsOpen(true);
      return;
    }
    setBusy(true);
    try {
      await onApply(trimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="presentation"
        onClick={onClose}
      >
        <Panel
          role="dialog"
          aria-modal="true"
          aria-label="Edit timeline with AI"
          className="flex w-full max-w-lg flex-col gap-3 p-5"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink">Edit timeline with AI</div>
              <p className="mt-1 text-xs text-ink-muted">
                Describe a change to the current timeline. The model rewrites the whole document; you review it on the
                canvas.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="AI provider settings"
              title={ready ? `${providerLabel} · ${config.model}` : "AI provider not configured"}
              className="inline-flex flex-none items-center gap-1.5 rounded border border-border-strong px-2 py-1 text-xs text-ink-muted hover:text-ink"
            >
              <GearIcon />
              {ready ? providerLabel : "Set up AI"}
            </button>
          </div>

          <textarea
            autoFocus
            rows={4}
            className={TEXTAREA_CLASS}
            placeholder="e.g. Add a 5-minute warm-up ramp before the first load, and extend the run to cover it."
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />

          <div className="space-y-1">
            <span className="text-xs font-medium text-ink-muted">Examples</span>
            <div className="flex flex-col gap-1">
              {EXAMPLE_EDITS.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setInstruction(example);
                    setError(null);
                  }}
                  className="rounded border border-border-strong px-2 py-1 text-left text-xs text-ink-muted hover:text-ink"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-status-fail">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" variant="primary" disabled={!trimmed || busy} onClick={apply}>
              {busy ? "Applying…" : ready ? "Apply change" : "Set up AI"}
            </Button>
          </div>
        </Panel>
      </div>

      {settingsOpen && (
        <LlmSettingsDialog
          initial={config}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setConfig(next);
            setError(null);
          }}
        />
      )}
    </>
  );
}
