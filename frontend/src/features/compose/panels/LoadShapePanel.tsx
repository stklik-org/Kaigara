import { useMemo } from "react";
import {
  BellShape,
  ConstantShape,
  IndividualShape,
  LoadShape,
  RampShape,
  SineShape,
  SpikeShape,
  type LoadShapeKind,
} from "@kaigara/shared-types";
import { Button } from "@/components/ui/Button";
import { useScenarioStore } from "../store/scenarioStore";
import { findLoad } from "../timeline/findLoad";
import { createDefaultShape, patchShape } from "../timeline/modelFactories";
import { NoLoadSelected, NumberField, PanelLabel, SelectField, TimeField } from "./fields";

const SHAPE_KIND_OPTIONS: { value: LoadShapeKind; label: string }[] = [
  { value: "ramp", label: "Ramp" },
  { value: "constant", label: "Constant" },
  { value: "spike", label: "Spike" },
  { value: "sine", label: "Sine" },
  { value: "bell", label: "Bell" },
  { value: "individual", label: "Individual" },
];

const DIRECTION_OPTIONS = [
  { value: "up" as const, label: "Up" },
  { value: "down" as const, label: "Down" },
];

const SINE_DIRECTION_OPTIONS = [
  { value: "rise" as const, label: "Rises first" },
  { value: "fall" as const, label: "Falls first" },
];

/** The fields specific to each concrete LoadShape subclass. Narrowed with `instanceof`, which is
 *  what actually narrows the class type — checking `shape.kind` only narrows the string literal,
 *  since the subclasses are not a discriminated union at the type level. Edits go through
 *  `patchShape`, so no branch has to restate the fields it is *not* changing. */
function ShapeFields({ shape, onChange }: { shape: LoadShape; onChange: (next: LoadShape) => void }) {
  if (shape instanceof RampShape) {
    return (
      <>
        <SelectField
          label="Direction"
          value={shape.direction}
          options={DIRECTION_OPTIONS}
          onChange={(direction) => onChange(patchShape(shape, { direction }))}
        />
        <NumberField
          label="From rate/sec"
          value={shape.fromRatePerSec}
          onChange={(fromRatePerSec) => onChange(patchShape(shape, { fromRatePerSec }))}
        />
        <NumberField
          label="To rate/sec"
          value={shape.toRatePerSec}
          onChange={(toRatePerSec) => onChange(patchShape(shape, { toRatePerSec }))}
        />
      </>
    );
  }

  if (shape instanceof ConstantShape) {
    return (
      <NumberField
        label="Rate/sec"
        value={shape.ratePerSec}
        onChange={(ratePerSec) => onChange(patchShape(shape, { ratePerSec }))}
      />
    );
  }

  if (shape instanceof SpikeShape) {
    return (
      <NumberField
        label="Magnitude rate/sec"
        value={shape.magnitudeRatePerSec}
        onChange={(magnitudeRatePerSec) => onChange(patchShape(shape, { magnitudeRatePerSec }))}
      />
    );
  }

  if (shape instanceof SineShape) {
    return (
      <>
        <SelectField
          label="Direction"
          value={shape.direction}
          options={SINE_DIRECTION_OPTIONS}
          onChange={(direction) => onChange(patchShape(shape, { direction }))}
        />
        <NumberField
          label="Base rate/sec"
          value={shape.baseRatePerSec}
          onChange={(baseRatePerSec) => onChange(patchShape(shape, { baseRatePerSec }))}
        />
        <NumberField
          label="Amplitude rate/sec"
          value={shape.amplitudeRatePerSec}
          onChange={(amplitudeRatePerSec) => onChange(patchShape(shape, { amplitudeRatePerSec }))}
        />
      </>
    );
  }

  if (shape instanceof BellShape) {
    return (
      <NumberField
        label="Peak rate/sec"
        value={shape.peakRatePerSec}
        onChange={(peakRatePerSec) => onChange(patchShape(shape, { peakRatePerSec }))}
      />
    );
  }

  if (shape instanceof IndividualShape) {
    return (
      <NumberField
        label="Request count"
        value={shape.requestCount}
        onChange={(requestCount) => onChange(patchShape(shape, { requestCount }))}
      />
    );
  }

  // Unreachable for every kind the metamodel defines; a new subclass shows up here as a shape with
  // no tunable fields rather than as a crash.
  return null;
}

/** Top-left panel — the wireframe's pink-labeled "LOAD SHAPE" card. Shape is a dropdown over the
 *  six LoadShapeKinds (switching kind rebuilds the shape from its own default, so stale fields
 *  from the previous kind don't linger); Start/Duration and every shape-specific field write
 *  straight through `scenarioStore.updateLoad`.
 *
 *  Laid out as one narrow vertical column rather than the old four-across grid: the info row now
 *  gives most of its width to the request catalogue, and a column of stacked fields survives being
 *  dragged down to ~170px in a way a grid does not. */
export function LoadShapePanel() {
  const timeline = useScenarioStore((s) => s.timeline);
  const selectedLoadId = useScenarioStore((s) => s.selectedLoadId);
  const pendingLoad = useScenarioStore((s) => s.pendingLoad);
  const updateLoad = useScenarioStore((s) => s.updateLoad);
  const savePendingLoad = useScenarioStore((s) => s.savePendingLoad);
  const removeLoad = useScenarioStore((s) => s.removeLoad);
  const found = useMemo(
    () => findLoad(timeline, selectedLoadId, pendingLoad),
    [timeline, selectedLoadId, pendingLoad],
  );

  if (!found) {
    return (
      <div className="p-2">
        <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
        <NoLoadSelected />
      </div>
    );
  }

  const { track, load } = found;

  /** Switching kind replaces the whole shape, and an instantaneous kind pins the duration to 0 —
   *  the model has no notion of a spike that lasts a while. */
  function handleKindChange(nextKind: LoadShapeKind) {
    const shape = createDefaultShape(nextKind);
    updateLoad(track.id, load.id, { shape, durationSeconds: shape.instantaneous ? 0 : load.durationSeconds });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none px-2 pt-2">
        <PanelLabel color="var(--color-track-magenta)">Load shape</PanelLabel>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex flex-col gap-2">
          <SelectField label="Shape" value={load.shape.kind} options={SHAPE_KIND_OPTIONS} onChange={handleKindChange} />
          <TimeField
            label="Start"
            value={load.startSeconds}
            onChange={(startSeconds) => updateLoad(track.id, load.id, { startSeconds })}
          />
          <TimeField
            label="Duration"
            value={load.durationSeconds}
            disabled={load.shape.instantaneous}
            onChange={(durationSeconds) => updateLoad(track.id, load.id, { durationSeconds })}
          />
          <ShapeFields shape={load.shape} onChange={(shape) => updateLoad(track.id, load.id, { shape })} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {found.pending && (
            <Button variant="primary" className="px-2 py-1 text-xs" onClick={savePendingLoad}>
              Save
            </Button>
          )}
          <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => removeLoad(track.id, load.id)}>
            Delete load
          </Button>
        </div>
      </div>
    </div>
  );
}
