/**
 * The JSON Schema for a LoadTimeline document, as a plain object so consumers (Monaco's JSON
 * language service) can use it directly with no JSON-module-resolution setup.
 *
 * **This is the single source of truth.** `../schema/load-timeline.schema.json` is generated from
 * it by `npm run schema:emit -w @kaigara/shared-types`; `schema:check` fails if the two have
 * drifted. Runtime validation of an actual document lives in `loadTimelineValidation.ts` and must
 * be kept aligned with the rules here — this schema drives the editor's squiggles, that validator
 * drives what the store and the backend will accept.
 */
export const loadTimelineSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://kaigara.dev/schema/load-timeline.schema.json",
  title: "LoadTimeline",
  description:
    "Mirrors packages/shared-types/src/loadTimeline.ts, loadShape.ts, requestComposition.ts and requestGenerator.ts — kept in sync by hand for now.",
  type: "object",
  required: ["totalDurationSeconds", "tracks"],
  additionalProperties: false,
  properties: {
    totalDurationSeconds: { type: "number", minimum: 0 },
    tracks: { type: "array", items: { $ref: "#/definitions/Track" } },
  },
  definitions: {
    RequestOperation: { type: "string", enum: ["create", "read", "update", "delete", "query"] },
    RequestTargetEntity: { type: "string", enum: ["shell", "submodel"] },
    RandomizedGenerator: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sizeBytes"],
      properties: {
        kind: { const: "randomized" },
        sizeBytes: { type: "number", minimum: 0 },
      },
    },
    ExactGenerator: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: {
        kind: { const: "exact" },
        value: { type: "string" },
      },
    },
    MutateGenerator: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "baseValue", "mutationRatePercent"],
      properties: {
        kind: { const: "mutate" },
        baseValue: { type: "string" },
        mutationRatePercent: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    RequestGenerator: {
      oneOf: [
        { $ref: "#/definitions/RandomizedGenerator" },
        { $ref: "#/definitions/ExactGenerator" },
        { $ref: "#/definitions/MutateGenerator" },
      ],
    },
    RequestSpec: {
      type: "object",
      additionalProperties: false,
      required: ["id", "operation", "target", "weight", "generator"],
      properties: {
        id: { type: "string" },
        operation: { $ref: "#/definitions/RequestOperation" },
        target: { $ref: "#/definitions/RequestTargetEntity" },
        weight: { type: "number", minimum: 0 },
        generator: { $ref: "#/definitions/RequestGenerator" },
        templateId: { type: "string" },
        bindings: { $ref: "#/definitions/ParameterBindings" },
        idPool: { $ref: "#/definitions/RequestIdPool" },
      },
    },
    RequestIdPool: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      description: "Where the identifier a request addresses comes from. Absent means \"created\".",
      properties: {
        source: { type: "string", enum: ["created", "server"] },
        maxIds: { type: "number", minimum: 1 },
      },
    },
    ParameterBindings: {
      type: "object",
      description: "Parameter id -> how it was bound in the catalogue template named by templateId.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["strategy"],
        properties: {
          strategy: { type: "string" },
          // Shaped by the chosen strategy's own JSON Schema, which lives in the catalogue folder
          // rather than here — so this stays deliberately open.
          config: { type: "object" },
        },
      },
    },
    RequestComposition: {
      type: "object",
      additionalProperties: false,
      required: ["requests"],
      properties: {
        requests: { type: "array", items: { $ref: "#/definitions/RequestSpec" } },
      },
    },
    RampShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "direction", "fromRatePerSec", "toRatePerSec"],
      properties: {
        kind: { const: "ramp" },
        direction: { type: "string", enum: ["up", "down"] },
        fromRatePerSec: { type: "number", minimum: 0 },
        toRatePerSec: { type: "number", minimum: 0 },
      },
    },
    ConstantShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "ratePerSec"],
      properties: {
        kind: { const: "constant" },
        ratePerSec: { type: "number", minimum: 0 },
      },
    },
    SpikeShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "magnitudeRatePerSec"],
      properties: {
        kind: { const: "spike" },
        magnitudeRatePerSec: { type: "number", minimum: 0 },
      },
    },
    SineShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "peakRatePerSec"],
      properties: {
        kind: { const: "sine" },
        peakRatePerSec: { type: "number", minimum: 0 },
      },
    },
    BellShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "peakRatePerSec"],
      properties: {
        kind: { const: "bell" },
        peakRatePerSec: { type: "number", minimum: 0 },
      },
    },
    IndividualShape: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requestCount"],
      properties: {
        kind: { const: "individual" },
        requestCount: { type: "number", minimum: 0 },
      },
    },
    LoadShape: {
      oneOf: [
        { $ref: "#/definitions/RampShape" },
        { $ref: "#/definitions/ConstantShape" },
        { $ref: "#/definitions/SpikeShape" },
        { $ref: "#/definitions/SineShape" },
        { $ref: "#/definitions/BellShape" },
        { $ref: "#/definitions/IndividualShape" },
      ],
    },
    Load: {
      type: "object",
      additionalProperties: false,
      required: ["id", "startSeconds", "durationSeconds", "shape", "requests"],
      properties: {
        id: { type: "string" },
        startSeconds: { type: "number", minimum: 0 },
        durationSeconds: { type: "number", minimum: 0 },
        shape: { $ref: "#/definitions/LoadShape" },
        requests: { $ref: "#/definitions/RequestComposition" },
      },
    },
    Track: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "loads"],
      properties: {
        id: { type: "string" },
        label: { type: "string" },
        // Optional: emitted by Track.toJSON() only once the user picks a colour from the track
        // swatch. Left undefined, the timeline derives one from the palette (see shapeVisuals.ts).
        color: { type: "string", description: "Track colour override, e.g. \"#3b82f6\"." },
        loads: { type: "array", items: { $ref: "#/definitions/Load" } },
      },
    },
  },
} as const;
