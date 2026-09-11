/** A row of mutually exclusive buttons in a bordered pill — the Compose screen's Visual/Code
 *  toggle and the overlay chart's Overlaid/Stacked toggle are the same control, so they are the
 *  same component.
 *
 *  Each segment is an `aria-pressed` toggle button rather than a `role="radio"` group: a real
 *  radiogroup owes the user arrow-key navigation and roving tabstops, and claiming the role
 *  without them reads worse to a screen reader than the plain buttons this actually is. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Accessible name for the group as a whole (e.g. "Compose view"). */
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 rounded-md border border-border-strong p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            option.value === value ? "bg-accent text-white" : "text-ink-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
