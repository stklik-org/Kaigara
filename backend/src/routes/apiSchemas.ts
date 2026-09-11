/**
 * The OpenAPI vocabulary the routes are documented with.
 *
 * Two rules shape this file.
 *
 * **The timeline schema is imported, never restated.** `loadTimelineSchema` in
 * `@kaigara/shared-types` is the single source of truth for what a `LoadTimeline` document looks
 * like (it is also what generates `schema/load-timeline.schema.json` and what drives the Compose
 * Code view's squiggles). Swagger UI therefore shows the *same* shape the editor enforces, and a
 * field added to the metamodel appears here for free — one less place in the "adding a field means
 * touching four files" list.
 *
 * **Documentation must not become validation.** `loadTimelineValidation.ts` is the single
 * validator for an untrusted timeline, and `scenarioDocument.ts` the single reader for an
 * untrusted scenario; both produce a 422 with a per-path issue list that the editor can point at.
 * If Fastify's Ajv also validated these bodies, a bad document would be rejected earlier, by a
 * different validator, with a different error shape — so `documented()` attaches the schema for
 * the docs and switches request validation and response serialization off. See its comment.
 */

import type { FastifySchema, RouteShorthandOptions } from "fastify";
import type { OpenAPIV3_1 } from "openapi-types";
import { loadTimelineSchema } from "@kaigara/shared-types";

type JsonSchema = Record<string, unknown>;

/** What `@fastify/swagger` wants in `components.schemas`: `openapi-types`' own nominal
 *  `SchemaObject`. Named here so the one cast that reaches it has somewhere to point. */
type OpenApiSchemas = Record<string, OpenAPIV3_1.SchemaObject>;

/**
 * Attaches a schema for documentation only.
 *
 * Fastify uses a route's `schema` for three things: generating the OpenAPI document, validating
 * the request with Ajv, and serializing the response with fast-json-stringify. We want the first
 * and not the other two — the domain validators own rejection (with the issue lists the frontend
 * renders), and a response serializer would silently drop any field of `RunView` this file has not
 * enumerated, which is exactly the drift a wire contract exists to prevent.
 */
export function documented(schema: FastifySchema): RouteShorthandOptions {
  return {
    schema,
    // Accepts everything; `collectLoadTimelineIssues` / `parseScenarioDocument` / the route's own
    // guards decide what is actually a bad request.
    validatorCompiler: () => () => true,
    // Pass-through: send the object as-is rather than through a schema-derived serializer.
    serializerCompiler: () => (data) => JSON.stringify(data),
  };
}

/** `#/definitions/X` (JSON Schema draft-07, what the generator emits) -> `#/components/schemas/X`
 *  (OpenAPI). Structural, so it keeps working as definitions are added to the metamodel. */
function toComponentRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toComponentRefs);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] =
      key === "$ref" && typeof value === "string" && value.startsWith("#/definitions/")
        ? value.replace("#/definitions/", "#/components/schemas/")
        : toComponentRefs(value);
  }
  return out;
}

/** `$schema` and `$id` are draft-07 document markers; inside `components.schemas` they name a
 *  dialect and an identity that are no longer this schema's, so they are dropped rather than
 *  carried along. `definitions` is hoisted separately, just below. */
const { $schema: _schema, $id: _id, definitions, ...timelineRoot } = loadTimelineSchema as JsonSchema & {
  definitions: Record<string, JsonSchema>;
};

/** Every `definitions` entry of the timeline schema, hoisted to OpenAPI components. */
const timelineComponents = Object.fromEntries(
  Object.entries(definitions).map(([name, schema]) => [name, toComponentRefs(schema)]),
) as Record<string, JsonSchema>;

export const LOAD_TIMELINE_REF = "#/components/schemas/LoadTimeline";

const runTarget: JsonSchema = {
  type: "object",
  title: "RunTarget",
  description: "Where the generated requests are sent. The AAS server's API root — the path the IDTA-01002 endpoints hang off, so `/shells` resolves under it.",
  required: ["baseUrl"],
  properties: {
    baseUrl: {
      type: "string",
      description: "e.g. `http://127.0.0.1:8081/api/v3` — the local stub AAS server (`npm run stub-aas -w backend`).",
      examples: ["http://127.0.0.1:8081/api/v3"],
    },
    timeoutSeconds: { type: "number", minimum: 0, description: "Per-request timeout. Defaults to 30." },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Sent with every generated request; where authentication goes once it exists.",
    },
  },
};

const validationIssue: JsonSchema = {
  type: "object",
  title: "ValidationIssue",
  required: ["path", "message", "severity"],
  properties: {
    path: { type: "string", description: 'Where in the document, e.g. `tracks[0].loads[1].shape`.' },
    message: { type: "string" },
    severity: { type: "string", enum: ["error", "warning"] },
  },
};

const apiError: JsonSchema = {
  type: "object",
  title: "ApiError",
  required: ["error"],
  additionalProperties: true,
  properties: {
    error: { type: "string", description: "Human-readable, meant to be shown verbatim." },
    issues: {
      type: "array",
      items: { $ref: "#/components/schemas/ValidationIssue" },
      description: "Present on 422: the per-path issue list, so a UI can point at the offending property instead of only saying \"invalid\".",
    },
  },
};

/**
 * `RunView` as documentation, not as a contract.
 *
 * The contract is `packages/shared-types/src/runExecution.ts`, which both ends import; restating
 * it exhaustively here would create a third copy to keep in sync. So this enumerates the top-level
 * fields a caller navigates by and leaves `additionalProperties` open rather than pretending to be
 * complete.
 */
const runView: JsonSchema = {
  type: "object",
  title: "RunView",
  description:
    "Everything known about one run. The authoritative shape is `RunView` in `packages/shared-types/src/runExecution.ts`; the properties below are the ones you navigate by.",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["compiled", "starting", "running", "completed", "failed", "stopped"] },
    scenarioName: { type: "string" },
    connectionId: { type: "string" },
    engineId: { type: "string", description: 'Names an adapter. Only `"k6"` is implemented (ADR 0001).' },
    targetBaseUrl: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    endedAt: { type: "string", format: "date-time" },
    state: { type: "object", additionalProperties: true, description: "Projection onto the shape the Run screen renders (phases, elapsed, live series)." },
    plan: {
      type: "object",
      additionalProperties: true,
      description: "Plan summary: total duration, load count, and `expectedRequests` — the same number the Compose overlay previews.",
    },
    metrics: {
      type: "object",
      additionalProperties: true,
      description: "Server-side aggregates (per-load, per-operation, per-status totals and latency percentiles). Raw per-request events never cross this boundary.",
    },
    warnings: { type: "array", items: { $ref: "#/components/schemas/ValidationIssue" } },
    engineSummary: {
      type: "object",
      additionalProperties: true,
      description: "The engine's own end-of-run totals. A non-zero `droppedIterations` means the *tool* was the bottleneck, which invalidates the measurement.",
    },
    artifacts: {
      type: "array",
      description: "Readable via `GET /api/runs/{id}/artifacts/{name}` — `main.js`, the numbered scripts it schedules, and `plan.json`.",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" }, contentType: { type: "string" } },
      },
    },
    engineLog: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
};

const scenarioDocument: JsonSchema = {
  title: "ScenarioDocument",
  description:
    "A scenario file, in either of the two shapes `parseScenarioDocument` accepts: a full scenario object with a `phases.method` timeline, or a bare `LoadTimeline` (which is exactly what the Compose screen's Code view shows, so a document copied out of there pastes straight back in).",
  oneOf: [
    {
      type: "object",
      title: "Scenario",
      required: ["phases"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        connectionId: { type: "string" },
        phases: {
          type: "object",
          required: ["method"],
          properties: {
            preparation: { type: "array", items: { type: "object", additionalProperties: true } },
            preconditions: { type: "array", items: { type: "object", additionalProperties: true } },
            method: { $ref: LOAD_TIMELINE_REF },
            postconditions: { type: "array", items: { type: "object", additionalProperties: true } },
            cleanup: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
    },
    { $ref: LOAD_TIMELINE_REF },
  ],
};

const scenarioLibraryEntry: JsonSchema = {
  type: "object",
  title: "ScenarioLibraryEntry",
  required: ["id", "name", "description", "file"],
  properties: {
    id: { type: "string", description: "The file stem — what `GET /api/scenarios/{id}` takes." },
    name: { type: "string" },
    description: { type: "string" },
    file: { type: "string" },
    issues: {
      type: "array",
      items: { $ref: "#/components/schemas/ValidationIssue" },
      description: "Present when the file is in the folder but unusable. Broken files are listed with their reason rather than omitted — \"my scenario is missing\" is a worse answer than a named offending property.",
    },
  },
};

/**
 * Everything the spec's `components.schemas` holds: the timeline metamodel, hoisted from its
 * generated schema, plus the request/response shapes of this API.
 *
 * Cast because these are plain JSON Schema objects and half of them are *generated* — authoring
 * them against `openapi-types`' `SchemaObject` is not an option, and structural agreement is as
 * far as the guarantee goes. `test/openapi.test.ts` checks the document that comes out instead.
 */
export const componentSchemas = {
  ...timelineComponents,
  LoadTimeline: { ...toComponentRefs(timelineRoot) as JsonSchema, title: "LoadTimeline" },
  RunTarget: runTarget,
  ValidationIssue: validationIssue,
  ApiError: apiError,
  RunView: runView,
  ScenarioDocument: scenarioDocument,
  ScenarioLibraryEntry: scenarioLibraryEntry,
} as unknown as OpenApiSchemas;

/**
 * A minimal but genuinely runnable timeline: 5 submodel creations per second for 30 seconds.
 *
 * It is the default body Swagger UI puts in the "Try it out" box, so it has to be a document the
 * validator accepts and the compiler can turn into a plan — `test/openapi.test.ts` asserts exactly
 * that, which is what stops the example from rotting as the metamodel moves.
 */
export const EXAMPLE_TIMELINE = {
  totalDurationSeconds: 30,
  tracks: [
    {
      id: "writes",
      label: "Submodel writes",
      color: "#2977d6",
      loads: [
        {
          id: "steady",
          startSeconds: 0,
          durationSeconds: 30,
          shape: { kind: "constant", ratePerSec: 5 },
          requests: {
            requests: [
              {
                id: "create-submodel",
                operation: "create",
                target: "submodel",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 2048 },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const EXAMPLE_TARGET = { baseUrl: "http://127.0.0.1:8081/api/v3" };

export const errorResponse = (description: string): JsonSchema => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
});
