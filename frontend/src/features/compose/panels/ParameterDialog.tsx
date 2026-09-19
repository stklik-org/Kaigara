import { useEffect, useMemo } from "react";
import { RequestComposition, type ParameterBinding } from "@kaigara/shared-types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { requestTemplate } from "../catalog/catalog";
import {
  defaultConfig,
  resolveRequest,
  revalidateConfig,
  sampleOf,
  selectedFamily,
  strategiesFor,
  strategyDef,
  templateSelectionIssue,
} from "../catalog/resolve";
import { engineGaps, toRequestSpec } from "../catalog/toRequestSpec";
import { useIdtaTemplates } from "../catalog/useIdtaTemplates";
import type { CatalogDraft } from "./catalogDraft";
import { useScenarioStore } from "../store/scenarioStore";
import { findLoad } from "../timeline/findLoad";
import { MethodBadge } from "./MethodBadge";
import { SchemaFields } from "./SchemaFields";

/**
 * Configures one catalogue pick and commits it to the selected Load.
 *
 * Every field below the strategy pills is generated from that strategy's JSON Schema, so this
 * component knows nothing about identifiers, payload sizes or query conditions — which is what
 * keeps "add a way to fill a parameter" a data change. What it *does* own is the honesty: the
 * resolved URL, the expected status (which a strategy may override), and what the engine will
 * actually do with the pick today.
 */
export function ParameterDialog({ draft, onChange, onClose }: {
  draft: CatalogDraft;
  onChange: (draft: CatalogDraft) => void;
  onClose: () => void;
}) {
  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const updateLoad = useScenarioStore((s) => s.updateLoad);
  const savePendingLoad = useScenarioStore((s) => s.savePendingLoad);
  const idtaTemplates = useIdtaTemplates();

  const template = requestTemplate(draft.templateId);
  const found = useMemo(
    () => findLoad(timeline, selectedLoadId, pendingLoad),
    [timeline, selectedLoadId, pendingLoad],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!template) return null;

  const resolved = resolveRequest(template, draft.bindings);
  const gaps = engineGaps(template, draft.bindings);
  const family = selectedFamily(draft.bindings);
  const selectionIssue = templateSelectionIssue(template, draft.bindings);

  function setBinding(parameterId: string, binding: ParameterBinding) {
    onChange({ ...draft, bindings: { ...draft.bindings, [parameterId]: binding } });
  }

  function commit() {
    if (!found || !template) return;
    const { track, load } = found;
    const existing = load.requests.requests;
    const spec = toRequestSpec(
      template,
      draft.bindings,
      draft.weight,
      draft.editingRequestId ?? undefined,
    );
    const next = draft.editingRequestId
      ? existing.map((request) => (request.id === draft.editingRequestId ? spec : request))
      : [...existing, spec];
    updateLoad(track.id, load.id, { requests: new RequestComposition(next) });

    // Adding a request to a still-unsaved Load commits it. Giving a Load traffic is a clear
    // statement that it is meant, and a draft that is never saved takes its requests down with it
    // — so the alternative is a request the user watched appear in the list and then lost. Editing
    // or removing one says nothing new about the Load, and leaves the draft alone.
    if (found.pending && !draft.editingRequestId) savePendingLoad();

    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={onClose}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${template.title}`}
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MethodBadge template={template} />
          <div className="text-sm font-semibold text-ink">{template.title}</div>
          <div className="truncate font-mono text-xs text-ink-muted">
            {template.kind === "composite" ? `${template.steps?.length ?? 0} steps` : template.endpoint?.path}
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] overflow-hidden">
          <div className="flex flex-col gap-3 overflow-y-auto p-4">
            {(template.parameters ?? []).map((parameter) => {
              const binding = draft.bindings[parameter.id];
              const strategy = strategyDef(parameter, binding?.strategy);
              return (
                <Panel key={parameter.id} className="p-3">
                  <div className="mb-2 flex items-baseline gap-2">
                    <div className="text-[13px] font-semibold text-ink">{parameter.label}</div>
                    <div className="font-mono text-[10px] text-ink-muted">{parameter.type}</div>
                    <div className="ml-auto max-w-[45%] truncate rounded border border-dashed border-border-strong bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                      {sampleOf(parameter, binding) || "—"}
                    </div>
                  </div>

                  <div className="mb-2 flex flex-wrap gap-1">
                    {strategiesFor(parameter).map((option) => {
                      const active = option.id === binding?.strategy;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            setBinding(parameter.id, { strategy: option.id, config: defaultConfig(option) })
                          }
                          className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${
                            active
                              ? "border-accent bg-accent-bg font-semibold text-accent"
                              : "border-border-strong text-ink-muted hover:text-ink"
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>

                  {strategy?.hint && <div className="mb-2 text-[11px] text-ink-muted">{strategy.hint}</div>}
                  {strategy?.warning && (
                    <div className="mb-2 rounded border border-status-warn bg-status-warn-bg px-2 py-1 text-[11px] text-status-warn">
                      ⚠ {strategy.warning}
                    </div>
                  )}

                  <SchemaFields
                    strategy={strategy}
                    config={binding?.config ?? {}}
                    family={family}
                    onChange={(key, value) => {
                      const config = { ...(binding?.config ?? {}), [key]: value };
                      setBinding(parameter.id, {
                        strategy: binding?.strategy ?? "",
                        config: revalidateConfig(strategy, config, idtaTemplates),
                      });
                    }}
                  />
                </Panel>
              );
            })}
            {(template.parameters ?? []).length === 0 && (
              <div className="text-[12px] text-ink-muted">This pattern has no parameters.</div>
            )}
          </div>

          <aside className="flex flex-col gap-3 overflow-y-auto border-l border-border bg-surface-sunken p-3">
            <div>
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                Resulting request
              </div>
              <pre className="overflow-hidden rounded border border-border bg-surface p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink">
                {template.kind === "composite"
                  ? (template.steps ?? [])
                      .map((step, index) => {
                        const stepTemplate = requestTemplate(step.ref);
                        return `${index + 1}. ${stepTemplate?.endpoint?.method ?? ""} ${stepTemplate?.endpoint?.path ?? step.ref}`;
                      })
                      .join("\n")
                  : `${resolved.method} ${resolved.path}${resolved.body ? `\n\n${resolved.body}` : ""}`}
              </pre>
            </div>

            {resolved.encoded.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                  Base64url-encoded in the path
                </div>
                {resolved.encoded.map((line) => (
                  <div key={line} className="font-mono text-[10.5px] break-all text-ink-muted">
                    {line}
                  </div>
                ))}
              </div>
            )}

            <div>
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                Expected status
              </div>
              <div className="flex flex-wrap gap-1">
                {resolved.expect.length > 0 ? (
                  resolved.expect.map((code) => (
                    <Badge key={code} tone={code >= 400 ? "warn" : "pass"}>
                      {code}
                    </Badge>
                  ))
                ) : (
                  <span className="text-[11px] text-ink-muted">per step</span>
                )}
              </div>
            </div>

            {gaps.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-status-warn uppercase">
                  What the engine does today
                </div>
                <ul className="list-disc space-y-1 pl-4 text-[11px] text-ink-muted">
                  {gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </div>
            )}

            {template.notes && <div className="text-[11px] text-ink-muted">{template.notes}</div>}
          </aside>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          {!draft.editingRequestId && template.addDisabled ? (
            <div className="min-w-0 flex-1 truncate text-[11px] text-status-warn">{template.addDisabledReason}</div>
          ) : selectionIssue ? (
            <div className="min-w-0 flex-1 truncate text-[11px] text-status-warn">{selectionIssue}</div>
          ) : (
            <div className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{template.summary}</div>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!found || Boolean(!draft.editingRequestId && template.addDisabled) || Boolean(selectionIssue)}
            onClick={commit}
          >
            {draft.editingRequestId ? "Save changes" : "Add to composition"}
          </Button>
        </footer>
      </Panel>
    </div>
  );
}
