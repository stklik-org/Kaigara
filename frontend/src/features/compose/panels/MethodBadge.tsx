import type { RequestTemplate } from "../catalog/types";

/** The HTTP verb of a catalogue pattern, coloured the way the wireframes colour operations:
 *  reads green, creates blue, writes amber, deletes red. A composite has no single verb, so it
 *  shows its step count instead. */
const METHOD_CLASSES: Record<string, string> = {
  GET: "border-status-pass bg-status-pass-bg text-status-pass",
  POST: "border-accent bg-accent-bg text-accent",
  PUT: "border-status-warn bg-status-warn-bg text-status-warn",
  PATCH: "border-status-warn bg-status-warn-bg text-status-warn",
  DELETE: "border-status-fail bg-status-fail-bg text-status-fail",
  SEQ: "border-border-strong bg-surface-sunken text-ink-muted",
};

function methodOf(template: RequestTemplate): string {
  return template.kind === "composite" ? "SEQ" : (template.endpoint?.method ?? "?");
}

export function MethodBadge({ template }: { template: RequestTemplate }) {
  const method = methodOf(template);
  return (
    <span
      className={`inline-flex flex-none items-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
        METHOD_CLASSES[method] ?? METHOD_CLASSES.SEQ
      }`}
    >
      {method}
    </span>
  );
}
