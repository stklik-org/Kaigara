import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { saveLlmConfig, type LlmConfig, type LlmProviderId } from "@/lib/assist/llmConfig";
import { LLM_PROVIDERS, providerDef, type VerifyResult } from "@/lib/assist/llmProviders";

const FIELD_CLASS =
  "w-full rounded border border-field-border bg-field px-2 py-1 text-sm text-ink outline-none focus:border-accent";

const PROVIDER_OPTIONS = Object.values(LLM_PROVIDERS).map((p) => ({ value: p.id, label: p.label }));

/**
 * The popup behind the settings wheel on "Generate from description".
 *
 * Flow: pick a provider, paste a key, hit **Check key**. That runs the provider's authenticated
 * models call — a 200 confirms the key and returns the callable model ids, which fill the picker;
 * a 401/403 says the key is wrong. Save writes the whole config to `localStorage` (see
 * `llmConfig.ts`). Nothing here touches the backend.
 */
export function LlmSettingsDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: LlmConfig;
  onClose: () => void;
  onSaved: (config: LlmConfig) => void;
}) {
  const [draft, setDraft] = useState<LlmConfig>(initial);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const def = providerDef(draft.provider);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      abortRef.current?.abort();
    };
  }, [onClose]);

  function patch(change: Partial<LlmConfig>) {
    setDraft((prev) => ({ ...prev, ...change }));
  }

  function switchProvider(provider: LlmProviderId) {
    abortRef.current?.abort();
    setChecking(false);
    setResult(null);
    setDraft((prev) => ({ ...prev, provider, model: "", baseUrl: "" }));
  }

  async function check() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setChecking(true);
    setResult(null);
    try {
      const verified = await def.verify(draft, controller.signal);
      setResult(verified);
      // Auto-pick a model if the current one is gone (or unset) and the list is non-empty.
      if (verified.models.length > 0 && !verified.models.includes(draft.model)) {
        patch({ model: preferredModel(draft.provider, verified.models) });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setResult({ ok: false, detail: (error as Error).message, models: [] });
    } finally {
      setChecking(false);
    }
  }

  function save() {
    const config: LlmConfig = { ...draft, baseUrl: draft.baseUrl?.trim() || undefined };
    saveLlmConfig(config);
    onSaved(config);
    onClose();
  }

  const models = result?.models ?? [];
  const canSave = draft.apiKey.trim() !== "" && draft.model.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={onClose}
    >
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="AI provider settings"
        className="flex w-full max-w-lg flex-col gap-4 p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <div className="text-sm font-semibold text-ink">AI provider</div>
          <p className="mt-1 text-xs text-ink-muted">
            Used only to turn a description into a scenario. The key is stored in this browser
            (localStorage) and sent directly to the provider — it never reaches the Kaigara backend.
          </p>
        </div>

        <SegmentedControl<LlmProviderId>
          label="AI provider"
          value={draft.provider}
          options={PROVIDER_OPTIONS}
          onChange={switchProvider}
        />

        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-muted">
            API key —{" "}
            <a className="text-accent hover:underline" href={def.keyUrl} target="_blank" rel="noreferrer">
              create one
            </a>
          </span>
          <input
            className={`${FIELD_CLASS} font-mono`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={def.keyHint}
            value={draft.apiKey}
            onChange={(event) => {
              patch({ apiKey: event.target.value });
              setResult(null);
            }}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-muted">
            Base URL <span className="font-normal">— override, optional</span>
          </span>
          <input
            className={`${FIELD_CLASS} font-mono`}
            placeholder={def.defaultBaseUrl}
            value={draft.baseUrl ?? ""}
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </label>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={check} disabled={checking || draft.apiKey.trim() === ""}>
            {checking ? "Checking…" : "Check key"}
          </Button>
          {result && (
            <span className="flex items-center gap-2 text-xs text-ink-muted">
              <Badge tone={result.ok ? "pass" : "fail"}>{result.ok ? "Valid" : "Failed"}</Badge>
              <span>{result.detail}</span>
            </span>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-muted">Model</span>
          {models.length > 0 ? (
            <select
              className={FIELD_CLASS}
              value={draft.model}
              onChange={(event) => patch({ model: event.target.value })}
            >
              {!models.includes(draft.model) && <option value="">Select a model…</option>}
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`${FIELD_CLASS} font-mono`}
              placeholder="e.g. meta-llama/Llama-3.3-70B-Instruct"
              value={draft.model}
              onChange={(event) => patch({ model: event.target.value })}
            />
          )}
          {def.modelHint && <span className="block text-[11px] text-ink-muted">{def.modelHint}</span>}
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** Nudge the default selection toward a small/cheap instruct model where the name makes that obvious. */
function preferredModel(provider: LlmProviderId, models: string[]): string {
  const patterns =
    provider === "openai"
      ? [/^gpt-4o-mini$/, /mini/, /^gpt-4o$/]
      : provider === "anthropic"
        ? [/haiku/, /sonnet/]
        : [/instruct/i, /chat/i];
  for (const pattern of patterns) {
    const hit = models.find((id) => pattern.test(id));
    if (hit) return hit;
  }
  return models[0];
}
