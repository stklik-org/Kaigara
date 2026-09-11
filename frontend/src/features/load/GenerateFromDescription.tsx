import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel, SectionLabel } from "@/components/ui/Panel";
import { isLlmConfigReady, loadLlmConfig } from "@/lib/assist/llmConfig";
import { providerDef } from "@/lib/assist/llmProviders";
import { EXAMPLE_DESCRIPTIONS } from "./exampleDescriptions";
import { LlmSettingsDialog } from "./LlmSettingsDialog";

/**
 * The "Generate scenario from description" affordance at the top of the Load screen: a free-text
 * box, ready-made example descriptions, a settings wheel for the LLM provider, and a Generate
 * button that (once wired) sends the text to the configured model and drops the resulting scenario
 * into Compose — the same destination as the drop zone.
 *
 * Provider setup is done: the wheel opens `LlmSettingsDialog`, which checks the key, lists the
 * callable models, and persists the choice to `localStorage`. The generation call itself is the
 * `onGenerate` seam — it takes the description plus the stored config, builds the schema-anchored
 * prompt, and validates the reply with `parseLoadTimeline`. Left unset, the button reports the
 * config state instead of pretending to run.
 */
const TEXTAREA_CLASS =
  "w-full resize-y rounded border border-field-border bg-field px-2 py-1.5 text-sm text-ink outline-none focus:border-accent";

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
    </svg>
  );
}

export function GenerateFromDescription({
  onGenerate,
}: {
  /** Hands the description + current provider config to the LLM pipeline. Resolves once the
   *  generated scenario has been loaded into Compose; rejects with a message safe to show. */
  onGenerate?: (description: string) => Promise<void>;
}) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState(loadLlmConfig);

  const trimmed = description.trim();
  const ready = isLlmConfigReady(config);
  const providerLabel = providerDef(config.provider).label;

  async function generate() {
    setNote(null);
    if (!ready) {
      setSettingsOpen(true);
      return;
    }
    if (!onGenerate) {
      setNote(`Provider ready — ${providerLabel} · ${config.model}. Generation wiring is the next step.`);
      return;
    }
    setBusy(true);
    try {
      await onGenerate(trimmed);
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <SectionLabel>Generate from description</SectionLabel>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="AI provider settings"
          title={ready ? `${providerLabel} · ${config.model}` : "AI provider not configured"}
          className="inline-flex items-center gap-1.5 rounded border border-border-strong px-2 py-1 text-xs text-ink-muted hover:text-ink"
        >
          <GearIcon />
          {ready ? providerLabel : "Set up AI"}
        </button>
      </div>

      <Panel className="mt-2 space-y-3 p-4">
        <p className="text-xs text-ink-muted">
          Describe the benchmark in plain language. The configured model turns it into a timeline you review and edit in
          Compose.
        </p>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-muted">Description</span>
          <textarea
            rows={4}
            className={TEXTAREA_CLASS}
            placeholder="e.g. Ramp up to 200 submodel reads per second over a minute, hold for five minutes, then ramp down."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <div className="space-y-1">
          <span className="text-xs font-medium text-ink-muted">Examples</span>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_DESCRIPTIONS.map((example) => (
              <Button
                key={example.id}
                type="button"
                className="text-xs"
                title={example.text}
                onClick={() => {
                  setDescription(example.text);
                  setNote(null);
                }}
              >
                {example.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button type="button" variant="primary" disabled={!trimmed || busy} onClick={generate}>
            {busy ? "Generating…" : "Generate scenario"}
          </Button>
          {!ready && !note && (
            <span className="text-xs text-ink-muted">No AI provider configured — the button opens settings.</span>
          )}
          {note && <span className="text-xs text-ink-muted">{note}</span>}
        </div>
      </Panel>

      {settingsOpen && (
        <LlmSettingsDialog
          initial={config}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setConfig(next);
            setNote(null);
          }}
        />
      )}
    </div>
  );
}
