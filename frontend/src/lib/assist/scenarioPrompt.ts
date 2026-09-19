import { loadTimelineSchema, type ValidationIssue } from "@kaigara/shared-types";

/**
 * Prompts for the two assist flows, built from one shared body:
 *
 *  - `scenarioSystemPrompt()` — a plain-language description becomes a new `LoadTimeline`.
 *  - `editSystemPrompt()`     — an instruction is applied to an existing `LoadTimeline`.
 *
 * The in-context learning is: the JSON Schema (`loadTimelineSchema`, the source
 * `load-timeline.schema.json` is generated from), inlined verbatim; a prose cheat-sheet of the
 * semantics the schema cannot carry (which shape matches which words, that tracks run
 * concurrently, that only five operations against two targets are executable — see
 * `backend/src/timeline/aasOperations.ts`); and, for generation, two worked pairs that both
 * validate against `loadTimelineValidation.ts` with zero issues.
 *
 * Both flows target the bare method timeline (`{ totalDurationSeconds, tracks }`) — exactly what
 * the Compose Code view shows.
 */

/** Minimal create → read → delete lifecycle. Matches the "minimal" example description. */
const EXAMPLE_MINIMAL = {
  totalDurationSeconds: 40,
  tracks: [
    {
      id: "lifecycle",
      label: "AAS lifecycle",
      loads: [
        {
          id: "create-shell",
          startSeconds: 0,
          durationSeconds: 0,
          shape: { kind: "individual", requestCount: 1 },
          requests: {
            requests: [
              { id: "post-shell", operation: "create", target: "shell", weight: 1, generator: { kind: "randomized", sizeBytes: 512 } },
            ],
          },
        },
        {
          id: "create-submodels",
          startSeconds: 0,
          durationSeconds: 0,
          shape: { kind: "individual", requestCount: 3 },
          requests: {
            requests: [
              { id: "post-submodel", operation: "create", target: "submodel", weight: 1, generator: { kind: "randomized", sizeBytes: 512 } },
            ],
          },
        },
        {
          id: "read-values",
          startSeconds: 10,
          durationSeconds: 0,
          shape: { kind: "individual", requestCount: 5 },
          requests: {
            requests: [
              {
                id: "get-submodel",
                operation: "read",
                target: "submodel",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 0 },
                idPool: { source: "created" },
              },
            ],
          },
        },
        {
          id: "delete-shell",
          startSeconds: 30,
          durationSeconds: 0,
          shape: { kind: "individual", requestCount: 1 },
          requests: {
            requests: [
              {
                id: "del-shell",
                operation: "delete",
                target: "shell",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 0 },
                idPool: { source: "created" },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** Ramp up / hold / ramp down of reads against a pre-existing corpus. */
const EXAMPLE_RAMP = {
  totalDurationSeconds: 420,
  tracks: [
    {
      id: "reads",
      label: "Submodel reads",
      loads: [
        {
          id: "ramp-up",
          startSeconds: 0,
          durationSeconds: 60,
          shape: { kind: "ramp", direction: "up", fromRatePerSec: 0, toRatePerSec: 200 },
          requests: {
            requests: [
              {
                id: "read-sm",
                operation: "read",
                target: "submodel",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 0 },
                idPool: { source: "server" },
              },
            ],
          },
        },
        {
          id: "hold",
          startSeconds: 60,
          durationSeconds: 300,
          shape: { kind: "constant", ratePerSec: 200 },
          requests: {
            requests: [
              {
                id: "read-sm",
                operation: "read",
                target: "submodel",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 0 },
                idPool: { source: "server" },
              },
            ],
          },
        },
        {
          id: "ramp-down",
          startSeconds: 360,
          durationSeconds: 60,
          shape: { kind: "ramp", direction: "down", fromRatePerSec: 200, toRatePerSec: 0 },
          requests: {
            requests: [
              {
                id: "read-sm",
                operation: "read",
                target: "submodel",
                weight: 1,
                generator: { kind: "randomized", sizeBytes: 0 },
                idPool: { source: "server" },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** Everything both prompts share: the output contract, the metamodel cheat-sheet, and the schema. */
const TIMELINE_RULES = `OUTPUT RULES
- Output exactly one JSON object and nothing else. No prose, no explanation, no Markdown code fences.
- The object MUST validate against the JSON Schema below (draft-07). Respect every "enum", "const", "required", and "additionalProperties": false. Do not add fields that are not in the schema.

DOCUMENT SHAPE
The root is a LoadTimeline: { "totalDurationSeconds": number, "tracks": Track[] }.
- totalDurationSeconds is the wall-clock length of the whole run, in seconds.
- A Track is one lane: { "id", "label", "loads": Load[] }. Tracks run CONCURRENTLY. Put things that happen at the same time on separate tracks; put a sequence of phases on one track as loads with increasing startSeconds.
- A Load is one scheduled burst of traffic: { "id", "startSeconds", "durationSeconds", "shape": LoadShape, "requests": { "requests": RequestSpec[] } }.
  - startSeconds is measured from the start of the run.
  - Every load id must be unique across the WHOLE document. Every request id must be unique within its load.

LOAD SHAPES — pick the one that matches the words used
- "individual"  { "kind": "individual", "requestCount": N } — fire exactly N requests once. Use for "create an AAS", "read five values", "delete it". durationSeconds MUST be 0.
- "constant"    { "kind": "constant", "ratePerSec": R } — hold a steady rate for the load's duration. Use for "R requests per second for M minutes". durationSeconds MUST be > 0.
- "ramp"        { "kind": "ramp", "direction": "up"|"down", "fromRatePerSec": A, "toRatePerSec": B } — linear change over the duration. Use for "ramp up", "ramp down", "increase to". durationSeconds MUST be > 0.
- "spike"       { "kind": "spike", "magnitudeRatePerSec": R } — one instantaneous burst at startSeconds. Use for "spike", "sudden surge". durationSeconds MUST be 0.
- "sine"        { "kind": "sine", "baseRatePerSec": B, "amplitudeRatePerSec": A, "direction": "rise"|"fall" } — one full oscillation around base B across the duration: "rise" goes base -> base+A -> base -> base-A -> base, "fall" the mirror image. Use for "wave", "daily/weekly curve", "oscillating". durationSeconds MUST be > 0.
- "bell"        { "kind": "bell", "peakRatePerSec": R } — one smooth hump (0 -> peak -> 0) across the duration, for a single one-off event. Use for "one peak event". durationSeconds MUST be > 0.

REQUESTS — what a load sends
Each RequestSpec: { "id", "operation", "target", "weight", "generator", and optionally "idPool" }.
- operation is ONE of "create", "read", "update", "delete", "query". target is ONE of "shell", "submodel". Nothing else is executable. If the description implies element-level access, attachments, $value/$metadata, or filter queries, approximate with the closest of these five and add no extra fields.
  - create: POST a new entity (it mints its own id).
  - read:   GET one entity by id.
  - query:  GET a page of the entity collection ("list", "search", "poll the collection").
  - update: PUT one entity by id.
  - delete: DELETE one entity by id.
- weight is the relative share of this request within its load (positive numbers, need not sum to 100). One request in a load: weight 1.
- generator produces the request body:
  - { "kind": "randomized", "sizeBytes": N } — synthetic body of about N bytes. Default for create/update when no payload is described. Use sizeBytes 0 for read/query/delete (they send no body).
  - { "kind": "exact", "value": "<a string containing JSON>" } — a fixed body.
  - { "kind": "mutate", "baseValue": "<a string containing JSON>", "mutationRatePercent": 0..100 } — vary a share of a base body per request.
- idPool: for read/update/delete against data this run did NOT create, add { "source": "server" }. Omit it (it defaults to "created") when the same load, or an earlier load on the timeline, created those entities. create and query never use idPool. On a "server" source, "onEmpty" ("warn", the default, or "fail") says what happens if the target's corpus for that entity is empty: "warn" skips the request and the run continues; "fail" refuses to compile. Only set it to "fail" if the request is deliberately meant to fail loudly on an empty target — leave it out otherwise.

CONVERSION GUIDELINES
- Convert every time expression to seconds: "a minute" = 60, "10 minutes" = 600, "half an hour" = 1800, "an 8-hour run" = 28800.
- Set totalDurationSeconds to cover the last load's startSeconds + durationSeconds, plus a few seconds of headroom for trailing instantaneous loads.
- Prefer a few clearly-labelled tracks. A create -> read -> delete lifecycle is one track, staggered by startSeconds.
- When rates are not specified, choose plausible values and keep them consistent with any numbers given.

JSON SCHEMA — the output MUST validate against this:
${JSON.stringify(loadTimelineSchema, null, 2)}`;

const SCENARIO_SYSTEM_PROMPT = `You are a load-test scenario compiler for Kaigara, a standards-based benchmarking tool for Asset Administration Shell (AAS) servers. You convert a plain-language description of a benchmark into ONE JSON document describing the generated load over time.

${TIMELINE_RULES}

EXAMPLES

Description: Create a single AAS with three submodels, read five values after 10 seconds, then delete it again after 30 seconds.
${JSON.stringify(EXAMPLE_MINIMAL)}

Description: Ramp up to 200 submodel reads per second over one minute, hold that rate for five minutes, then ramp back down to zero over one minute.
${JSON.stringify(EXAMPLE_RAMP)}`;

const EDIT_SYSTEM_PROMPT = `You are a load-test scenario editor for Kaigara, a standards-based benchmarking tool for Asset Administration Shell (AAS) servers. You are given an existing benchmark timeline as JSON and an instruction describing a change. You apply the change and return the COMPLETE updated timeline.

EDITING RULES
- Return the whole document, not a diff and not only the changed parts.
- Change only what the instruction asks for. Keep every other track, load, id, label, colour, rate, and timing exactly as given.
- Preserve existing "id" values so the change is a modification, not a replacement. Give any genuinely new track or load a fresh unique id.
- Keep each track's "color" as-is if present; omit "color" on new tracks.
- If the instruction cannot be expressed in this model, apply the closest valid change and add nothing outside the schema.

${TIMELINE_RULES}`;

export function scenarioSystemPrompt(): string {
  return SCENARIO_SYSTEM_PROMPT;
}

export function scenarioUserPrompt(description: string): string {
  return `Description: ${description.trim()}\n\nReturn the LoadTimeline JSON object.`;
}

export function editSystemPrompt(): string {
  return EDIT_SYSTEM_PROMPT;
}

export function editUserPrompt(currentTimelineJson: string, instruction: string): string {
  return `Current LoadTimeline:\n${currentTimelineJson}\n\nChange to apply: ${instruction.trim()}\n\nReturn the complete updated LoadTimeline JSON object.`;
}

export function scenarioRepairPrompt(issues: ValidationIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === "error");
  const lines = (errors.length > 0 ? errors : issues)
    .slice(0, 20)
    .map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`)
    .join("\n");
  return `That document did not validate against the schema:\n${lines}\n\nReturn a corrected LoadTimeline JSON object. Output only the JSON.`;
}
