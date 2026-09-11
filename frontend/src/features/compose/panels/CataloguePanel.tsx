import { useMemo, useState } from "react";
import type { RequestOperation } from "@kaigara/shared-types";
import { REQUEST_TEMPLATES, catalogIssues } from "../catalog/catalog";
import { useScenarioStore } from "../store/scenarioStore";
import { findLoad } from "../timeline/findLoad";
import type { CatalogTarget, RequestTemplate } from "../catalog/types";
import { draftForTemplate, type CatalogDraft } from "./catalogDraft";
import { MethodBadge } from "./MethodBadge";
import { OPERATION_COLOR } from "./operationStyle";
import { PanelLabel } from "./fields";

/**
 * The catalogue — the payload editor's main panel, and the only way to add a request.
 *
 * Its contents are the JSON files under `catalog/request-templates/`, so this component contains
 * no knowledge of AAS endpoints at all: it filters, searches and renders whatever the folder holds.
 *
 * A request belongs to a Load, so with nothing selected on the timeline there is nowhere to put
 * one. The head still renders — the title, the pills and their counts say what the catalogue holds
 * and stay usable for browsing — but the cards give way to a prompt, rather than offering 25
 * buttons that would each have to refuse.
 */

const OPERATIONS: (RequestOperation | "all")[] = ["all", "create", "read", "update", "delete", "query"];
const TARGETS: { value: CatalogTarget | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "aas", label: "AAS" },
  { value: "submodel", label: "Submodel" },
];

function FilterPills<T extends string>({
  label,
  value,
  options,
  counts,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  counts: Record<string, number>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <div className="w-14 flex-none text-[10px] tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors ${
                active
                  ? "border-accent bg-accent text-white"
                  : "border-border-strong text-ink-muted hover:text-ink"
              }`}
            >
              {option.label}
              <span className={`ml-1 text-[10px] ${active ? "opacity-75" : "opacity-60"}`}>
                {counts[option.value] ?? 0}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function matches(template: RequestTemplate, operation: RequestOperation | "all", target: CatalogTarget | "all", query: string): boolean {
  if (operation !== "all" && template.operation !== operation) return false;
  if (target !== "all" && template.target !== target && template.target !== "both") return false;
  if (query) {
    const haystack = `${template.title} ${template.summary} ${template.endpoint?.path ?? ""}`.toLowerCase();
    if (!haystack.includes(query.toLowerCase())) return false;
  }
  return true;
}

export function CataloguePanel({ onPick }: { onPick: (draft: CatalogDraft) => void }) {
  const [operation, setOperation] = useState<RequestOperation | "all">("all");
  const [target, setTarget] = useState<CatalogTarget | "all">("all");
  const [query, setQuery] = useState("");

  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const selectedLoad = useMemo(
    () => findLoad(timeline, selectedLoadId, pendingLoad),
    [timeline, selectedLoadId, pendingLoad],
  );

  const issues = useMemo(catalogIssues, []);
  const shown = REQUEST_TEMPLATES.filter((template) => matches(template, operation, target, query));

  const operationCounts = Object.fromEntries(
    OPERATIONS.map((value) => [
      value,
      REQUEST_TEMPLATES.filter((template) => value === "all" || template.operation === value).length,
    ]),
  );
  const targetCounts = Object.fromEntries(
    TARGETS.map(({ value }) => [
      value,
      REQUEST_TEMPLATES.filter((template) => value === "all" || template.target === value || template.target === "both")
        .length,
    ]),
  );

  // Which endpoints the current filter narrows to — the pills exist to pick an endpoint, so it
  // helps to say which ones are left rather than only how many cards are.
  const endpoints = [...new Set(shown.filter((t) => t.endpoint).map((t) => t.endpoint!.path.replace(/\{[^}]+\}/g, "{…}")))];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 px-2 pt-2">
        <PanelLabel color="var(--color-accent)">Request catalogue</PanelLabel>
        <div className="ml-auto flex items-center gap-2 pb-1.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search…"
            aria-label="Search request patterns"
            className="w-36 rounded border border-field-border bg-field px-2 py-0.5 text-[12px] text-ink outline-none focus:border-accent"
          />
          <span className="text-[11px] text-ink-muted">
            {shown.length}/{REQUEST_TEMPLATES.length}
          </span>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-1 border-b border-border px-2 pb-2">
        <FilterPills
          label="Operation"
          value={operation}
          counts={operationCounts}
          onChange={setOperation}
          options={OPERATIONS.map((value) => ({
            value,
            label: value === "all" ? "All" : value[0].toUpperCase() + value.slice(1),
          }))}
        />
        <FilterPills label="Target" value={target} counts={targetCounts} onChange={setTarget} options={TARGETS} />
        <div className="truncate pl-15 text-[10.5px] text-ink-muted">
          {operation === "all" && target === "all"
            ? `${REQUEST_TEMPLATES.length} patterns over ${endpoints.length} endpoints`
            : `endpoints: ${endpoints.slice(0, 3).join(" · ")}${endpoints.length > 3 ? ` +${endpoints.length - 3}` : ""}`}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!selectedLoad && (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <div className="text-[13px] text-ink-muted">Select a load on the timeline to add requests to it.</div>
            <div className="text-[11px] text-ink-muted">
              Every request belongs to one load, so there is nowhere to put one yet.
            </div>
          </div>
        )}

        {selectedLoad && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(294px,1fr))] gap-2">
            {shown.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onPick(draftForTemplate(template))}
                title={`Add ${template.title}`}
                className="group relative flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-surface py-2 pr-2 pl-3 text-left transition-colors hover:border-accent"
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: OPERATION_COLOR[template.operation] }}
                />
                <div className="flex items-center gap-1.5">
                  <MethodBadge template={template} />
                  <span className="truncate text-[12.5px] font-semibold text-ink">{template.title}</span>
                </div>
                <div className="font-mono text-[10.5px] break-all text-ink-muted">
                  {template.kind === "composite" ? `${template.steps?.length ?? 0} steps` : template.endpoint?.path}
                </div>
                <div className="flex-1 text-[11px] text-ink-muted">{template.summary}</div>
                <div className="flex flex-wrap items-center gap-1">
                  {(template.parameters ?? []).map((parameter) => (
                    <span
                      key={parameter.id}
                      className="rounded-full border border-border-strong px-1.5 text-[9.5px] text-ink-muted"
                    >
                      {parameter.label}
                    </span>
                  ))}
                  {template.execution === "authoring" && (
                    <span
                      title="The engine issues the nearest call it knows; the extra detail is recorded in the document."
                      className="rounded-full border border-status-warn bg-status-warn-bg px-1.5 text-[9.5px] text-status-warn"
                    >
                      authoring
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        {selectedLoad && shown.length === 0 && (
          <div className="p-6 text-center text-[12px] text-ink-muted">Nothing matches this filter.</div>
        )}
      </div>

      {issues.length > 0 && (
        <div className="flex-none border-t border-border bg-status-fail-bg px-2 py-1 text-[11px] text-status-fail">
          {issues.length} catalogue reference {issues.length === 1 ? "error" : "errors"}: {issues[0]}
        </div>
      )}
    </div>
  );
}
