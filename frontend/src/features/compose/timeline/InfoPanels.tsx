import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BellShape,
  ConstantShape,
  ExactGenerator,
  IndividualShape,
  LoadShape,
  MutateGenerator,
  RampShape,
  RandomizedGenerator,
  RequestComposition,
  RequestGenerator,
  RequestSpec,
  SineShape,
  SpikeShape,
  type LoadShapeKind,
  type RequestGeneratorKind,
  type RequestOperation,
  type RequestTargetEntity,
} from "@kaigara/shared-types";
import { Button } from "../../../components/ui/Button";
import { useScenarioStore } from "../store/scenarioStore";
import { findLoad } from "./findLoad";
import { createDefaultShape } from "./shapeVisuals";
import { formatMMSS, parseMMSS } from "./formatTime";

const SHAPE_KIND_OPTIONS: { value: LoadShapeKind; label: string }[] = [
  { value: "ramp", label: "Ramp" },
  { value: "constant", label: "Constant" },
  { value: "spike", label: "Spike" },
  { value: "sine", label: "Sine" },
  { value: "bell", label: "Bell" },
  { value: "individual", label: "Individual" },
];

const OPERATION_OPTIONS: { value: RequestOperation; label: string }[] = [
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
  { value: "query", label: "Query" },
];

const TARGET_OPTIONS: { value: RequestTargetEntity; label: string }[] = [
  { value: "shell", label: "Shell" },
  { value: "submodel", label: "Submodel" },
];

const GENERATOR_KIND_OPTIONS: { value: RequestGeneratorKind; label: string }[] = [
  { value: "randomized", label: "Randomized" },
  { value: "exact", label: "Exact" },
  { value: "mutate", label: "Mutate" },
];

function createDefaultGenerator(kind: RequestGeneratorKind): RequestGenerator {
  switch (kind) {
    case "randomized":
      return RandomizedGenerator.createDefault();
    case "exact":
      return ExactGenerator.createDefault();
    case "mutate":
      return MutateGenerator.createDefault();
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 truncate text-[11px] text-ink-muted">{label}</div>
      <div className="rounded border border-field-border bg-field px-2 py-1">{children}</div>
    </div>
  );
}

function SelectField<T extends string>({
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
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full truncate bg-transparent text-[12px] text-ink outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function NumberField({
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
        className="w-full bg-transparent text-[12px] text-ink outline-none disabled:text-ink-muted"
      />
    </Field>
  );
}

/** Same value/onChange contract as NumberField (raw seconds), but reads/writes it as "m:ss" —
 *  Start/Duration are more natural to think about in minutes once a scenario runs past a couple
 *  of minutes. Keeps a local draft while focused so mid-typing states like "1:" aren't fought
 *  with reformat-on-every-keystroke; invalid input reverts to the last good value on blur. */
function TimeField({
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
  const [text, setText] = useState(() => formatMMSS(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatMMSS(value));
  }, [value, focused]);

  function commit(raw: string) {
    const parsed = parseMMSS(raw);
    if (parsed !== null) {
      onChange(parsed);
      setText(formatMMSS(parsed));
    } else {
      setText(formatMMSS(value));
    }
  }

  return (
    <Field label={label}>
      <input
        type="text"
        inputMode="numeric"
        placeholder="m:ss"
        value={text}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-full bg-transparent text-[12px] text-ink outline-none disabled:text-ink-muted"
      />
    </Field>
  );
}

function PanelLabel({ color, children }: { color: string; children: string }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold tracking-wide uppercase" style={{ color }}>
      {children}
    </div>
  );
}

function EmptyState() {
  return <div className="text-[12px] text-ink-muted">Select a load on the timeline to inspect it.</div>;
}

/** The dynamic fields for each concrete LoadShape subclass — every subclass has different
 *  properties, so this switches via `instanceof` (which narrows the TS type, unlike checking
 *  `shape.kind` — that only narrows the string literal, not the class, since LoadShape's
 *  subclasses aren't a discriminated union at the type level) rather than forcing one generic
 *  field list. */
function ShapeFields({ shape, onChange }: { shape: LoadShape; onChange: (next: LoadShape) => void }) {
  if (shape instanceof RampShape) {
    return (
      <>
        <SelectField
          label="Direction"
          value={shape.direction}
          options={[
            { value: "up", label: "Up" },
            { value: "down", label: "Down" },
          ]}
          onChange={(direction) =>
            onChange(new RampShape({ direction, fromRatePerSec: shape.fromRatePerSec, toRatePerSec: shape.toRatePerSec }))
          }
        />
        <NumberField
          label="From rate/sec"
          value={shape.fromRatePerSec}
          onChange={(fromRatePerSec) => onChange(new RampShape({ direction: shape.direction, fromRatePerSec, toRatePerSec: shape.toRatePerSec }))}
        />
        <NumberField
          label="To rate/sec"
          value={shape.toRatePerSec}
          onChange={(toRatePerSec) => onChange(new RampShape({ direction: shape.direction, fromRatePerSec: shape.fromRatePerSec, toRatePerSec }))}
        />
      </>
    );
  }

  if (shape instanceof ConstantShape) {
    return <NumberField label="Rate/sec" value={shape.ratePerSec} onChange={(ratePerSec) => onChange(new ConstantShape({ ratePerSec }))} />;
  }

  if (shape instanceof SpikeShape) {
    return (
      <NumberField
        label="Magnitude rate/sec"
        value={shape.magnitudeRatePerSec}
        onChange={(magnitudeRatePerSec) => onChange(new SpikeShape({ magnitudeRatePerSec }))}
      />
    );
  }

  if (shape instanceof SineShape) {
    return (
      <NumberField label="Peak rate/sec" value={shape.peakRatePerSec} onChange={(peakRatePerSec) => onChange(new SineShape({ peakRatePerSec }))} />
    );
  }

  if (shape instanceof BellShape) {
    return (
      <NumberField label="Peak rate/sec" value={shape.peakRatePerSec} onChange={(peakRatePerSec) => onChange(new BellShape({ peakRatePerSec }))} />
    );
  }

  // individual
  const individualShape = shape as IndividualShape;
  return (
    <NumberField
      label="Request count"
      value={individualShape.requestCount}
      onChange={(requestCount) => onChange(new IndividualShape({ requestCount }))}
    />
  );
}

/** Top-left panel — mirrors the wireframe's pink-labeled "LOAD SHAPE" card. Shape is a dropdown
 *  over the 6 LoadShapeKinds (switching kind rebuilds the shape via createDefault(), so stale
 *  fields from the previous kind don't linger); Start/Duration and every shape-specific field are
 *  numeric/select inputs, all writing straight through scenarioStore.updateLoad. */
export function LoadShapePanel() {
  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const updateLoad = useScenarioStore((s) => s.updateLoad);
  const savePendingLoad = useScenarioStore((s) => s.savePendingLoad);
  const removeLoad = useScenarioStore((s) => s.removeLoad);
  const found = useMemo(() => findLoad(timeline, selectedLoadId, pendingLoad), [timeline, selectedLoadId, pendingLoad]);

  if (!found) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
        <EmptyState />
      </div>
    );
  }

  const { track, load } = found;

  function handleKindChange(nextKind: LoadShapeKind) {
    const nextShape = createDefaultShape(nextKind);
    updateLoad(track.id, load.id, {
      shape: nextShape,
      durationSeconds: nextShape.instantaneous ? 0 : load.durationSeconds,
    });
  }

  return (
    <div className="p-2">
      <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SelectField label="Shape" value={load.shape.kind} options={SHAPE_KIND_OPTIONS} onChange={handleKindChange} />
        <TimeField label="Start" value={load.startSeconds} onChange={(startSeconds) => updateLoad(track.id, load.id, { startSeconds })} />
        <TimeField
          label="Duration"
          value={load.durationSeconds}
          disabled={load.shape.instantaneous}
          onChange={(durationSeconds) => updateLoad(track.id, load.id, { durationSeconds })}
        />
        <ShapeFields shape={load.shape} onChange={(shape) => updateLoad(track.id, load.id, { shape })} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        {found.pending && (
          <Button variant="primary" onClick={savePendingLoad}>
            Save
          </Button>
        )}
        <Button variant="danger" onClick={() => removeLoad(track.id, load.id)}>
          Delete load
        </Button>
      </div>
    </div>
  );
}

/** The generator-specific fields for a RequestSpec's second row — same `instanceof`-switch
 *  approach as ShapeFields above, and for the same reason (RequestGenerator's subclasses aren't a
 *  discriminated union at the type level either). Exact and Mutate both carry a literal payload
 *  string that isn't a good fit for a numeric/select field, so they're edited via the "Specify
 *  payload in editor" button in RequestTargetPanel rather than inline here. */
function GeneratorFields({ generator, onChange }: { generator: RequestGenerator; onChange: (next: RequestGenerator) => void }) {
  if (generator instanceof RandomizedGenerator) {
    return (
      <div className="w-28">
        <NumberField label="Size (bytes)" value={generator.sizeBytes} onChange={(sizeBytes) => onChange(new RandomizedGenerator({ sizeBytes }))} />
      </div>
    );
  }

  if (generator instanceof MutateGenerator) {
    return (
      <div className="w-28">
        <NumberField
          label="Mutation %"
          value={generator.mutationRatePercent}
          onChange={(mutationRatePercent) => onChange(new MutateGenerator({ baseValue: generator.baseValue, mutationRatePercent }))}
        />
      </div>
    );
  }

  // exact — no tunable field, the literal value is set via the editor button.
  return null;
}

/** Top-right panel — the Request Composition metamodel: which AAS operations this Load actually
 *  sends, their relative weights, and (second row) how each one's payload data is generated.
 *  Fully editable: add/remove RequestSpec rows, change each row's operation/target/weight/
 *  generator. Entity-specific details (submodel subtype, semanticId source, ...) are deliberately
 *  not modeled yet. */
export function RequestTargetPanel() {
  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const updateLoad = useScenarioStore((s) => s.updateLoad);
  const setViewMode = useScenarioStore((s) => s.setViewMode);
  const found = useMemo(() => findLoad(timeline, selectedLoadId, pendingLoad), [timeline, selectedLoadId, pendingLoad]);

  if (!found) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-accent)">Request composition</PanelLabel>
        <EmptyState />
      </div>
    );
  }

  const { track, load } = found;
  const specs = load.requests.requests;

  function replaceRequests(next: RequestSpec[]) {
    updateLoad(track.id, load.id, { requests: new RequestComposition(next) });
  }

  function updateSpec(
    specId: string,
    patch: Partial<{ operation: RequestOperation; target: RequestTargetEntity; weight: number; generator: RequestGenerator }>,
  ) {
    replaceRequests(
      specs.map((spec) =>
        spec.id !== specId
          ? spec
          : new RequestSpec({
              id: spec.id,
              operation: patch.operation ?? spec.operation,
              target: patch.target ?? spec.target,
              weight: patch.weight ?? spec.weight,
              generator: patch.generator ?? spec.generator,
            }),
      ),
    );
  }

  function removeSpec(specId: string) {
    replaceRequests(specs.filter((spec) => spec.id !== specId));
  }

  function addSpec() {
    replaceRequests([...specs, RequestSpec.createDefault()]);
  }

  return (
    <div className="p-2">
      <PanelLabel color="var(--color-accent)">Request composition</PanelLabel>
      {specs.length === 0 && <div className="mb-2 text-[12px] text-ink-muted">No requests yet.</div>}
      <div className="space-y-2">
        {specs.map((spec) => (
          <div key={spec.id} className="rounded border border-border-strong p-1.5">
            <div className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2">
              <SelectField
                label="Operation"
                value={spec.operation}
                options={OPERATION_OPTIONS}
                onChange={(operation) => updateSpec(spec.id, { operation })}
              />
              <SelectField label="Target" value={spec.target} options={TARGET_OPTIONS} onChange={(target) => updateSpec(spec.id, { target })} />
              <NumberField label="Weight" value={spec.weight} onChange={(weight) => updateSpec(spec.id, { weight })} />
              <Button variant="danger" onClick={() => removeSpec(spec.id)} title="Remove this request">
                ×
              </Button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-end gap-2">
              <div className="w-28">
                <SelectField
                  label="Generator"
                  value={spec.generator.kind}
                  options={GENERATOR_KIND_OPTIONS}
                  onChange={(kind) => updateSpec(spec.id, { generator: createDefaultGenerator(kind) })}
                />
              </div>
              <GeneratorFields generator={spec.generator} onChange={(generator) => updateSpec(spec.id, { generator })} />
              {(spec.generator instanceof ExactGenerator || spec.generator instanceof MutateGenerator) && (
                <Button
                  variant="secondary"
                  onClick={() => setViewMode("code")}
                  title="Switch to the Code view to hand-write this request's payload"
                >
                  Specify payload in editor
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <Button variant="secondary" className="mt-2" onClick={addSpec}>
        + Add request
      </Button>
    </div>
  );
}
