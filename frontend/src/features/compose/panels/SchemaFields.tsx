import type { JsonSchemaProperty, Strategy } from "../catalog/types";
import { optionsFor } from "../catalog/resolve";
import { useIdtaTemplates } from "../catalog/useIdtaTemplates";
import { Field } from "./fields";

/**
 * Renders one strategy's options from its JSON Schema.
 *
 * This is what makes the catalogue extensible without code: a new strategy — or a new field on an
 * existing one — is a change to a JSON file under `catalog/parameter-types/`, and it appears here
 * automatically. Only a genuinely new *widget* needs a branch below.
 */

const CONTROL_CLASS = "w-full bg-transparent text-[12px] text-ink outline-none";

function Control({
  spec,
  value,
  family,
  onChange,
}: {
  spec: JsonSchemaProperty;
  value: unknown;
  family: string | undefined;
  onChange: (value: unknown) => void;
}) {
  const templates = useIdtaTemplates();
  const options = optionsFor(spec, family, templates);

  if (spec.format === "textarea") {
    return (
      <textarea
        rows={4}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className={`${CONTROL_CLASS} resize-y font-mono`}
      />
    );
  }
  if (options) {
    return (
      <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={`truncate ${CONTROL_CLASS}`}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (spec.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-[12px] text-ink">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {spec.title ?? "Enabled"}
      </label>
    );
  }
  if (spec.type === "integer" || spec.type === "number") {
    return (
      <input
        type="number"
        value={Number(value ?? 0)}
        min={spec.minimum}
        max={spec.maximum}
        onChange={(e) => onChange(Number(e.target.value))}
        className={CONTROL_CLASS}
      />
    );
  }
  return (
    <input
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      className={`${CONTROL_CLASS} font-mono`}
    />
  );
}

export function SchemaFields({
  strategy,
  config,
  family,
  onChange,
}: {
  strategy: Strategy | undefined;
  config: Record<string, unknown>;
  /** The IDTA template whose element paths the "pick from template" dropdowns should offer. */
  family: string | undefined;
  onChange: (key: string, value: unknown) => void;
}) {
  const properties = Object.entries(strategy?.schema?.properties ?? {}).filter(([, spec]) => {
    const when = spec["x-show-when"];
    return !when || config[when.field] === when.equals;
  });
  if (properties.length === 0) {
    return <div className="text-[12px] text-ink-muted">No further options.</div>;
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
      {properties.map(([key, spec]) => {
        // Textareas and data-driven dropdowns carry long values; give them the whole row.
        const wide = spec.format === "textarea" || Boolean(spec["x-options-from"]);
        return (
          <div key={key} className={wide ? "col-span-full" : undefined}>
            {spec.type === "boolean" ? (
              <div className="rounded border border-field-border bg-field px-2 py-1">
                <Control spec={spec} value={config[key]} family={family} onChange={(value) => onChange(key, value)} />
              </div>
            ) : (
              <Field label={spec.title ?? key}>
                <Control spec={spec} value={config[key]} family={family} onChange={(value) => onChange(key, value)} />
              </Field>
            )}
            {spec.description && <div className="mt-0.5 text-[11px] text-ink-muted">{spec.description}</div>}
          </div>
        );
      })}
    </div>
  );
}
