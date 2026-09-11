import {
  BellShape,
  ConstantShape,
  ExactGenerator,
  IndividualShape,
  Load,
  LoadShape,
  MutateGenerator,
  RampShape,
  RandomizedGenerator,
  RequestComposition,
  RequestGenerator,
  RequestSpec,
  SineShape,
  SpikeShape,
  Track,
  type LoadShapeData,
  type LoadShapeKind,
  type RequestGeneratorData,
  type RequestGeneratorKind,
  type RequestOperation,
  type RequestTargetEntity,
} from "@kaigara/shared-types";

/**
 * Constructors for the metamodel objects the Compose canvas creates — the click-to-add entry
 * points, and the one safe way to change a field on a polymorphic shape.
 *
 * Kept apart from `shapeVisuals.ts` (how an existing shape is *drawn*) because these decide what
 * ends up in the saved document, while that file decides nothing but pixels.
 */

export function createDefaultShape(kind: LoadShapeKind): LoadShape {
  switch (kind) {
    case "ramp":
      return RampShape.createDefault("up");
    case "constant":
      return ConstantShape.createDefault();
    case "spike":
      return SpikeShape.createDefault();
    case "sine":
      return SineShape.createDefault();
    case "bell":
      return BellShape.createDefault();
    case "individual":
      return IndividualShape.createDefault();
  }
}

/**
 * Returns `shape` with `patch` applied, as a new instance of the same subclass.
 *
 * LoadShape has no `.with()` of its own (unlike Load/Track/LoadTimeline) because its subclasses
 * have nothing in common to patch, so this round-trips through the serialized form and back
 * through `fromJSON` — which is exactly the constructor the document itself is read with. Never
 * object-spread the instance instead: that drops the prototype, and with it `rateAt()`/`toJSON()`.
 */
export function patchShape<S extends LoadShape>(shape: S, patch: Partial<ReturnType<S["toJSON"]>>): LoadShape {
  return LoadShape.fromJSON({ ...shape.toJSON(), ...patch } as LoadShapeData);
}

export function createDefaultGenerator(kind: RequestGeneratorKind): RequestGenerator {
  switch (kind) {
    case "randomized":
      return RandomizedGenerator.createDefault();
    case "exact":
      return ExactGenerator.createDefault();
    case "mutate":
      return MutateGenerator.createDefault();
  }
}

/** {@link patchShape} for a RequestSpec's generator — same polymorphic hierarchy, same reason it
 *  cannot simply be spread. */
export function patchGenerator<G extends RequestGenerator>(
  generator: G,
  patch: Partial<ReturnType<G["toJSON"]>>,
): RequestGenerator {
  return RequestGenerator.fromJSON({ ...generator.toJSON(), ...patch } as RequestGeneratorData);
}

/** Returns `spec` with `patch` applied. RequestSpec is not polymorphic, so its own fields can be
 *  carried over directly — note this spreads into the *constructor*, producing a real RequestSpec,
 *  rather than producing a plain object that has lost the class. */
export function withSpecFields(
  spec: RequestSpec,
  patch: Partial<{
    operation: RequestOperation;
    target: RequestTargetEntity;
    weight: number;
    generator: RequestGenerator;
  }>,
): RequestSpec {
  return new RequestSpec({
    id: spec.id,
    operation: spec.operation,
    target: spec.target,
    weight: spec.weight,
    generator: spec.generator,
    ...patch,
  });
}

/** How long a newly-added Load of each kind lasts. Instantaneous kinds are pinned to 0 in the
 *  model — they get their visual width from INSTANTANEOUS_VISUAL_SECONDS at render time. */
const DEFAULT_DURATION_SECONDS: Record<LoadShapeKind, number> = {
  ramp: 30,
  constant: 120,
  spike: 0,
  sine: 60,
  bell: 60,
  individual: 0,
};

/** Which LoadShapeKind a click-to-add on a given Track creates. Falls back to "constant" for an
 *  unrecognized track id rather than throwing — this only decides what is pre-selected for further
 *  editing. */
const DEFAULT_KIND_FOR_TRACK: Record<string, LoadShapeKind> = {
  ramp: "ramp",
  "periodic-burst": "sine",
  "peak-event": "bell",
  spike: "spike",
  "base-load": "constant",
  individual: "individual",
};

export function defaultKindForTrack(trackId: string): LoadShapeKind {
  return DEFAULT_KIND_FOR_TRACK[trackId] ?? "constant";
}

/** Ids are readable rather than opaque (`ramp-new-…`, not a UUID) because they are part of the
 *  document the Code view shows — a person reading that JSON should be able to tell which block a
 *  line belongs to. The counter only breaks ties within a millisecond. */
let nextId = 1;

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${nextId++}`;
}

/** A brand-new Load of `kind` starting at `startSeconds`, with that kind's default shape and an
 *  empty RequestComposition — the click-to-add-on-a-track entry point. */
export function createLoad(kind: LoadShapeKind, startSeconds: number): Load {
  const shape = createDefaultShape(kind);
  return new Load({
    id: newId(`${kind}-new`),
    startSeconds: Math.max(0, Math.round(startSeconds)),
    durationSeconds: shape.instantaneous ? 0 : DEFAULT_DURATION_SECONDS[kind],
    shape,
    requests: RequestComposition.empty(),
  });
}

/** An empty Track — the "+ Add track" entry point. It is left colourless on purpose: the store
 *  assigns a palette colour no sibling is using as it goes in (see `addTrack`). */
export function createTrack(): Track {
  return new Track({ id: newId("track"), label: "New track", loads: [] });
}
