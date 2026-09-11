import { useMemo } from "react";
import {
  RequestComposition,
  RequestSpec,
  type RequestOperation,
  type RequestTargetEntity,
} from "@kaigara/shared-types";
import { Button } from "@/components/ui/Button";
import { REQUEST_TEMPLATES, requestTemplate } from "../catalog/catalog";
import { resolveRequest, sampleOf, strategyDef } from "../catalog/resolve";
import { engineGaps, newRequestId } from "../catalog/toRequestSpec";
import { useScenarioStore } from "../store/scenarioStore";
import { findLoad } from "../timeline/findLoad";
import { withSpecFields } from "../timeline/modelFactories";
import { MethodBadge } from "./MethodBadge";
import { OPERATION_COLOR, OPERATION_METHOD } from "./operationStyle";
import { NoLoadSelected, PanelLabel } from "./fields";
import type { CatalogDraft } from "./catalogDraft";

/**
 * What the selected Load actually sends, as an ordered list with weights.
 *
 * Rows come in two shapes on purpose. A request authored from the catalogue carries its
 * `templateId`/`bindings`, so it renders as the pattern it is and reopens in the parameter dialog.
 * A request from a scenario written before the catalogue existed (every file in
 * `backend/scenarios/`) has only operation/target/weight — it stays fully editable inline, and can
 * be converted to the matching catalogue pattern rather than being deleted and re-added.
 */

const OPERATION_OPTIONS: { value: RequestOperation; label: string }[] = [
  { value: "create", label: "Create" },
  { value: "read", label: "Read" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
  { value: "query", label: "Query" },
];

const TARGET_OPTIONS: { value: RequestTargetEntity; label: string }[] = [
  { value: "shell", label: "Shell" },
  { value: "submodel", label: "Submodel" },
];

const INLINE_SELECT = "rounded border border-field-border bg-field px-1 py-0.5 text-[11px] text-ink outline-none";

/** The catalogue pattern a pre-catalogue spec would have been authored from, if there is exactly
 *  one engine-executable card for its (operation, target). */
function matchingTemplateId(spec: RequestSpec): string | undefined {
  const candidates = [...requestTemplateIdsFor(spec.operation, spec.target)];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function requestTemplateIdsFor(operation: RequestOperation, target: RequestTargetEntity): string[] {
  const wanted = target === "shell" ? "aas" : "submodel";
  return REQUEST_TEMPLATES.filter(
    (template) => template.execution === "engine" && template.operation === operation && template.target === wanted,
  ).map((template) => template.id);
}


export function CompositionPanel({ onEdit }: { onEdit: (draft: CatalogDraft) => void }) {
  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const updateLoad = useScenarioStore((s) => s.updateLoad);
  const found = useMemo(
    () => findLoad(timeline, selectedLoadId, pendingLoad),
    [timeline, selectedLoadId, pendingLoad],
  );

  if (!found) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-accent)">Request composition</PanelLabel>
        <NoLoadSelected />
      </div>
    );
  }

  const { track, load } = found;
  const specs = load.requests.requests;
  const totalWeight = specs.reduce((sum, spec) => sum + spec.weight, 0);

  function replace(next: RequestSpec[]) {
    updateLoad(track.id, load.id, { requests: new RequestComposition(next) });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 px-2 pt-2">
        <PanelLabel color="var(--color-accent)">Request composition</PanelLabel>
        <span className="ml-auto pb-1.5 text-[11px] text-ink-muted">{specs.length}</span>
      </div>

      {specs.length > 0 && (
        <div className="flex-none px-2 pb-1.5">
          <div className="flex h-2 overflow-hidden rounded-sm bg-field" title="Share of this load's requests">
            {specs.map((spec) => (
              <span
                key={spec.id}
                style={{
                  width: `${totalWeight ? (spec.weight / totalWeight) * 100 : 0}%`,
                  background: OPERATION_COLOR[spec.operation],
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {specs.length === 0 && (
          <div className="p-4 text-center text-[12px] text-ink-muted">
            No requests yet.
            <div className="mt-0.5 text-[11px]">Pick a pattern from the catalogue.</div>
          </div>
        )}

        {specs.map((spec) => {
          const template = spec.templateId ? requestTemplate(spec.templateId) : undefined;
          const share = totalWeight ? Math.round((spec.weight / totalWeight) * 100) : 0;
          const resolved = template ? resolveRequest(template, spec.bindings ?? {}) : null;
          const gaps = template ? engineGaps(template, spec.bindings ?? {}) : [];

          return (
            <div key={spec.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-1.5 border-b border-border px-2 py-1.5 hover:bg-field">
              {template ? (
                <MethodBadge template={template} />
              ) : (
                <span className="inline-flex flex-none items-center rounded border border-border-strong bg-surface-sunken px-1.5 py-0.5 text-[10px] font-bold text-ink-muted">
                  {OPERATION_METHOD[spec.operation]}
                </span>
              )}

              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[12px] font-semibold text-ink">
                    {template?.title ?? `${spec.operation} ${spec.target}`}
                  </span>
                  {resolved && (
                    <span className="truncate font-mono text-[10px] text-ink-muted" title={resolved.path}>
                      {resolved.path}
                    </span>
                  )}
                </div>

                {template ? (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {(template.parameters ?? []).map((parameter) => {
                      const binding = spec.bindings?.[parameter.id];
                      const strategy = strategyDef(parameter, binding?.strategy);
                      const negative = (strategy?.expect?.[0] ?? 0) >= 400;
                      return (
                        <span
                          key={parameter.id}
                          title={`${parameter.label}: ${sampleOf(parameter, binding)}`}
                          className={`max-w-full truncate rounded-full border px-1.5 text-[9.5px] ${
                            negative
                              ? "border-status-warn bg-status-warn-bg text-status-warn"
                              : "border-border-strong text-ink-muted"
                          }`}
                        >
                          {parameter.label}: {strategy?.label}
                        </span>
                      );
                    })}
                    {resolved && resolved.expect.length > 0 && (
                      <span className="rounded-full border border-border-strong px-1.5 text-[9.5px] text-ink-muted">
                        expect {resolved.expect.join("/")}
                      </span>
                    )}
                    {gaps.length > 0 && (
                      <span
                        title={gaps.join("\n")}
                        className="rounded-full border border-status-warn bg-status-warn-bg px-1.5 text-[9.5px] text-status-warn"
                      >
                        approximated ×{gaps.length}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <select
                      aria-label="Operation"
                      value={spec.operation}
                      onChange={(event) =>
                        replace(
                          specs.map((other) =>
                            other.id === spec.id
                              ? withSpecFields(other, { operation: event.target.value as RequestOperation })
                              : other,
                          ),
                        )
                      }
                      className={INLINE_SELECT}
                    >
                      {OPERATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Target"
                      value={spec.target}
                      onChange={(event) =>
                        replace(
                          specs.map((other) =>
                            other.id === spec.id
                              ? withSpecFields(other, { target: event.target.value as RequestTargetEntity })
                              : other,
                          ),
                        )
                      }
                      className={INLINE_SELECT}
                    >
                      {TARGET_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <span className="rounded-full border border-border-strong px-1.5 text-[9.5px] text-ink-muted">
                      {spec.generator.label}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  aria-label={`Weight of ${template?.title ?? spec.id}`}
                  value={spec.weight}
                  onChange={(event) =>
                    replace(
                      specs.map((other) =>
                        other.id === spec.id ? withSpecFields(other, { weight: Number(event.target.value) }) : other,
                      ),
                    )
                  }
                  className="w-11 rounded border border-field-border bg-field px-1 py-0.5 text-right text-[11px] text-ink outline-none"
                />
                <span className="w-7 text-right font-mono text-[10px] text-ink-muted">{share}%</span>
                <RowButton
                  label={template ? "Edit parameters" : "Configure with a catalogue pattern"}
                  disabled={!template && !matchingTemplateId(spec)}
                  onClick={() => {
                    const id = spec.templateId ?? matchingTemplateId(spec);
                    const picked = id ? requestTemplate(id) : undefined;
                    if (!picked) return;
                    onEdit({
                      templateId: picked.id,
                      weight: spec.weight,
                      bindings: spec.bindings ?? {},
                      editingRequestId: spec.id,
                    });
                  }}
                >
                  {template ? "✎" : "⇪"}
                </RowButton>
                <RowButton
                  label="Duplicate"
                  onClick={() =>
                    replace([
                      ...specs,
                      RequestSpec.fromJSON({ ...spec.toJSON(), id: newRequestId(spec.templateId ?? spec.operation) }),
                    ])
                  }
                >
                  ⧉
                </RowButton>
                <RowButton label="Remove" onClick={() => replace(specs.filter((other) => other.id !== spec.id))}>
                  ✕
                </RowButton>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-ink-muted">
        <span>Σ weight {totalWeight}</span>
        {specs.length > 0 && (
          <Button variant="secondary" className="ml-auto px-2 py-0.5 text-[11px]" onClick={() => replace([])}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}
