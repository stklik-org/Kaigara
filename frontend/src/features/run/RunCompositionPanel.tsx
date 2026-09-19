import type { Load } from "@kaigara/shared-types";
import { requestTemplate } from "../compose/catalog/catalog";
import { resolveRequest, sampleOf, strategyDef } from "../compose/catalog/resolve";
import { engineGaps } from "../compose/catalog/toRequestSpec";
import { MethodBadge } from "../compose/panels/MethodBadge";
import { NoLoadSelected, PanelLabel } from "../compose/panels/fields";
import { OPERATION_COLOR, OPERATION_METHOD } from "../compose/panels/operationStyle";

/**
 * Read-only sibling of Compose's `CompositionPanel` — same rows (method badge, resolved path,
 * parameter chips, weight/share), no inputs and no Edit/Duplicate/Remove: a run in progress
 * already executed a compiled plan, and this only shows what that plan was built from.
 */
export function RunCompositionPanel({ load }: { load: Load | undefined }) {
  if (!load) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-accent)">Request composition</PanelLabel>
        <NoLoadSelected />
      </div>
    );
  }

  const specs = load.requests.requests;
  const totalWeight = specs.reduce((sum, spec) => sum + spec.weight, 0);

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
        {specs.length === 0 && <div className="p-4 text-center text-[12px] text-ink-muted">This load sends no requests.</div>}

        {specs.map((spec) => {
          const template = spec.templateId ? requestTemplate(spec.templateId) : undefined;
          const share = totalWeight ? Math.round((spec.weight / totalWeight) * 100) : 0;
          const resolved = template ? resolveRequest(template, spec.bindings ?? {}) : null;
          const gaps = template ? engineGaps(template, spec.bindings ?? {}) : [];

          return (
            <div key={spec.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-1.5 border-b border-border px-2 py-1.5">
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
                  <div className="mt-0.5 flex items-center gap-1">
                    <span
                      className="rounded-full px-1.5 text-[9.5px] font-semibold text-white"
                      style={{ background: OPERATION_COLOR[spec.operation] }}
                    >
                      {spec.operation} {spec.target}
                    </span>
                    <span className="rounded-full border border-border-strong px-1.5 text-[9.5px] text-ink-muted">
                      {spec.generator.label}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span>{spec.weight}</span>
                <span className="w-8 text-right font-mono text-[10px]">{share}%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-ink-muted">
        <span>Σ weight {totalWeight}</span>
      </div>
    </div>
  );
}
