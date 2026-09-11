import type { ReactNode } from "react";
import { useMMSSDraft } from "../timeline/useMMSSDraft";

/**
 * The compact labelled inputs the two info panels are built from — a small label over a bordered
 * box, sized for a four-across grid rather than a form. Shared here so the Load Shape and Request
 * Composition panels stay visually identical as either grows new fields.
 */

const CONTROL_CLASS = "w-full bg-transparent text-[12px] text-ink outline-none disabled:text-ink-muted";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 truncate text-[11px] text-ink-muted">{label}</div>
      <div className="rounded border border-field-border bg-field px-2 py-1">{children}</div>
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`truncate ${CONTROL_CLASS}`}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={CONTROL_CLASS}
      />
    </Field>
  );
}

/** Same value/onChange contract as {@link NumberField} (raw seconds), but reads and writes it as
 *  `m:ss` — Start/Duration are more natural to think about in minutes once a scenario runs past a
 *  couple of them. The focus/commit behaviour lives in `useMMSSDraft`. */
export function TimeField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const draft = useMMSSDraft(value, onChange);

  return (
    <Field label={label}>
      <input {...draft} disabled={disabled} className={CONTROL_CLASS} />
    </Field>
  );
}

/** A panel's coloured heading — the wireframe's uppercase card labels. */
export function PanelLabel({ color, children }: { color: string; children: string }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold tracking-wide uppercase" style={{ color }}>
      {children}
    </div>
  );
}

/** What both panels show with no Load selected. */
export function NoLoadSelected() {
  return <div className="text-[12px] text-ink-muted">Select a load on the timeline to inspect it.</div>;
}
