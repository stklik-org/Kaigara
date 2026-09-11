/**
 * Structural + semantic validation for an untrusted `LoadTimelineData` document.
 *
 * The metamodel's own `fromJSON` constructors (loadTimeline.ts et al.) only guard the polymorphic
 * `kind` discriminants — everything else is read straight off the input, so a document missing
 * `startSeconds`, or carrying a string where a number belongs, would build a structurally intact
 * `LoadTimeline` whose fields are `undefined`/`NaN` and only fail much later (a blank timeline
 * block, or a k6 script with `NaN` in its stages). This module is the gate in front of that: it
 * is the single validator shared by
 *
 *   - the Compose Code view, which parses hand-edited JSON back into the store, and
 *   - the backend, which must not compile an unvalidated document into an engine script.
 *
 * Deliberately hand-rolled rather than ajv-backed: `@kaigara/shared-types` is imported directly
 * into the frontend bundle, and the minimal-footprint goal (proposal section 2.3) argues against
 * pulling a schema validator into it just for this. The rules below mirror
 * `load-timeline.schema.json`, which is what Monaco validates against in the editor — the two are
 * kept aligned by `npm run schema:check -w @kaigara/shared-types`.
 */

import { LoadTimeline, type LoadTimelineData } from "./loadTimeline.ts";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  /** Slash-separated path to the offending value, e.g. `tracks/0/loads/2/shape/ratePerSec`. */
  path: string;
  message: string;
  /** `error` means the document cannot be interpreted and must be rejected; `warning` means it is
   *  well-formed but almost certainly not what the author meant (e.g. a Load that sends nothing). */
  severity: ValidationSeverity;
}

export class TimelineValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const errors = issues.filter((issue) => issue.severity === "error");
    const summary = errors
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    super(
      errors.length === 0
        ? "Timeline validation failed"
        : `Timeline validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}): ${summary}${
            errors.length > 3 ? "; …" : ""
          }`,
    );
    this.name = "TimelineValidationError";
    this.issues = issues;
  }
}

const REQUEST_OPERATIONS = ["create", "read", "update", "delete", "query"] as const;
const ID_POOL_SOURCES = ["created", "server"] as const;
/** Operations that address a single entity by identifier, and therefore have an id pool at all.
 *  A create mints its own identifier and a query pages a collection; neither draws from a pool. */
const ID_ADDRESSING_OPERATIONS: readonly string[] = ["read", "update", "delete"];
const REQUEST_TARGETS = ["shell", "submodel"] as const;
const GENERATOR_KINDS = ["randomized", "exact", "mutate"] as const;
const SHAPE_KINDS = ["ramp", "constant", "spike", "sine", "bell", "individual"] as const;
const RAMP_DIRECTIONS = ["up", "down"] as const;

/** Shapes whose `rateAt()` is a real sustained rate over the Load's duration, as opposed to the
 *  instantaneous ones (spike/individual) that the data model pins to `durationSeconds: 0`. */
const SUSTAINED_SHAPE_KINDS: readonly string[] = ["ramp", "constant", "sine", "bell"];

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  error(path: string, message: string): void {
    this.issues.push({ path, message, severity: "error" });
  }

  warn(path: string, message: string): void {
    this.issues.push({ path, message, severity: "warning" });
  }

  get hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === "error");
  }
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}/${key}`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function readObject(c: IssueCollector, value: unknown, path: string, what: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    c.error(path, `expected ${what} object, got ${describe(value)}`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readArray(c: IssueCollector, value: unknown, path: string, what: string): unknown[] | undefined {
  if (!Array.isArray(value)) {
    c.error(path, `expected an array of ${what}, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function readNumber(
  c: IssueCollector,
  value: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    c.error(path, `expected a finite number, got ${typeof value === "number" ? String(value) : describe(value)}`);
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    c.error(path, `must be >= ${opts.min}, got ${value}`);
    return undefined;
  }
  if (opts.max !== undefined && value > opts.max) {
    c.error(path, `must be <= ${opts.max}, got ${value}`);
    return undefined;
  }
  return value;
}

function readString(c: IssueCollector, value: unknown, path: string, opts: { nonEmpty?: boolean } = {}): string | undefined {
  if (typeof value !== "string") {
    c.error(path, `expected a string, got ${describe(value)}`);
    return undefined;
  }
  if (opts.nonEmpty && value.trim() === "") {
    c.error(path, "must not be empty");
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(c: IssueCollector, value: unknown, path: string, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    c.error(path, `expected one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value as T;
}

/** Mirrors the schema's `additionalProperties: false`. Catching typos here (rather than silently
 *  dropping them) is the difference between "my rate change did nothing" and a pointed message. */
function rejectUnknownKeys(c: IssueCollector, obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      c.error(join(path, key), `unknown property "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function validateGenerator(c: IssueCollector, value: unknown, path: string): void {
  const obj = readObject(c, value, path, "a generator");
  if (!obj) return;

  const kind = readEnum(c, obj.kind, join(path, "kind"), GENERATOR_KINDS);
  if (!kind) return;

  switch (kind) {
    case "randomized":
      rejectUnknownKeys(c, obj, path, ["kind", "sizeBytes"]);
      readNumber(c, obj.sizeBytes, join(path, "sizeBytes"), { min: 0 });
      break;
    case "exact": {
      rejectUnknownKeys(c, obj, path, ["kind", "value"]);
      const literal = readString(c, obj.value, join(path, "value"));
      if (literal !== undefined && literal.trim() !== "") {
        try {
          JSON.parse(literal);
        } catch {
          // Not fatal — a target could legitimately be sent a non-JSON body — but for the AAS
          // REST API it is nearly always a mistake, so surface it without blocking the run.
          c.warn(join(path, "value"), "exact payload is not valid JSON; it will be sent verbatim as the request body");
        }
      }
      break;
    }
    case "mutate": {
      rejectUnknownKeys(c, obj, path, ["kind", "baseValue", "mutationRatePercent"]);
      const base = readString(c, obj.baseValue, join(path, "baseValue"));
      readNumber(c, obj.mutationRatePercent, join(path, "mutationRatePercent"), { min: 0, max: 100 });
      if (base !== undefined) {
        try {
          JSON.parse(base);
        } catch {
          c.warn(
            join(path, "baseValue"),
            "base payload is not valid JSON, so per-request mutation cannot descend into it; it will be sent unmodified",
          );
        }
      }
      break;
    }
  }
}

/**
 * Checks the catalogue provenance a request spec may carry (`templateId` + `bindings`).
 *
 * Deliberately structural only: which templates and strategies exist is decided by the catalogue
 * folder the editor loads, and this validator also runs in the backend, which has no business
 * knowing that folder. So it enforces the shape and the one cross-field rule that matters —
 * bindings without a templateId name parameters of nothing.
 */
function validateBindings(c: IssueCollector, request: Record<string, unknown>, path: string): void {
  if (request.templateId !== undefined) {
    readString(c, request.templateId, join(path, "templateId"), { nonEmpty: true });
  }
  if (request.bindings === undefined) return;

  if (request.templateId === undefined) {
    c.error(join(path, "bindings"), "bindings name the parameters of a request template, so templateId is required alongside them");
  }

  const bindings = readObject(c, request.bindings, join(path, "bindings"), "a bindings");
  if (!bindings) return;

  for (const [parameterId, value] of Object.entries(bindings)) {
    const bindingPath = join(join(path, "bindings"), parameterId);
    const binding = readObject(c, value, bindingPath, "a parameter binding");
    if (!binding) continue;
    rejectUnknownKeys(c, binding, bindingPath, ["strategy", "config"]);
    readString(c, binding.strategy, join(bindingPath, "strategy"), { nonEmpty: true });
    if (binding.config !== undefined) {
      readObject(c, binding.config, join(bindingPath, "config"), "a strategy config");
    }
  }
}

/**
 * Checks `idPool` — where a request draws the identifier it addresses.
 *
 * The one rule worth enforcing beyond the shape: an id pool on an operation that does not address
 * an identifier is a misunderstanding, not a preference. It is a warning rather than an error
 * because the request still runs correctly; it just carries a setting nothing can act on.
 */
function validateIdPool(c: IssueCollector, request: Record<string, unknown>, path: string): void {
  if (request.idPool === undefined) return;

  const idPoolPath = join(path, "idPool");
  const idPool = readObject(c, request.idPool, idPoolPath, "an id pool");
  if (!idPool) return;

  rejectUnknownKeys(c, idPool, idPoolPath, ["source", "maxIds"]);
  const source = readEnum(c, idPool.source, join(idPoolPath, "source"), ID_POOL_SOURCES);
  if (idPool.maxIds !== undefined) readNumber(c, idPool.maxIds, join(idPoolPath, "maxIds"), { min: 1 });

  const operation = typeof request.operation === "string" ? request.operation : undefined;
  if (source && operation && !ID_ADDRESSING_OPERATIONS.includes(operation)) {
    c.warn(
      idPoolPath,
      `"${operation}" does not address an entity by identifier, so its id pool is never consulted`,
    );
  }
}

function validateRequestComposition(c: IssueCollector, value: unknown, path: string, loadLabel: string): void {
  const obj = readObject(c, value, path, "a request composition");
  if (!obj) return;
  rejectUnknownKeys(c, obj, path, ["requests"]);

  const requests = readArray(c, obj.requests, join(path, "requests"), "request specs");
  if (!requests) return;

  if (requests.length === 0) {
    c.warn(join(path, "requests"), `${loadLabel} has no requests, so it will generate no traffic`);
    return;
  }

  const seenIds = new Set<string>();
  let totalWeight = 0;

  requests.forEach((entry, index) => {
    const requestPath = join(join(path, "requests"), index);
    const request = readObject(c, entry, requestPath, "a request spec");
    if (!request) return;
    rejectUnknownKeys(c, request, requestPath, [
      "id",
      "operation",
      "target",
      "weight",
      "generator",
      "templateId",
      "bindings",
      "idPool",
    ]);

    const id = readString(c, request.id, join(requestPath, "id"), { nonEmpty: true });
    if (id !== undefined) {
      if (seenIds.has(id)) c.error(join(requestPath, "id"), `duplicate request id "${id}" within the same load`);
      seenIds.add(id);
    }

    readEnum(c, request.operation, join(requestPath, "operation"), REQUEST_OPERATIONS);
    readEnum(c, request.target, join(requestPath, "target"), REQUEST_TARGETS);

    const weight = readNumber(c, request.weight, join(requestPath, "weight"), { min: 0 });
    if (weight !== undefined) totalWeight += weight;

    validateGenerator(c, request.generator, join(requestPath, "generator"));
    validateBindings(c, request, requestPath);
    validateIdPool(c, request, requestPath);
  });

  if (requests.length > 0 && totalWeight === 0) {
    c.warn(
      join(path, "requests"),
      `${loadLabel} has requests but their weights sum to 0, so none of them can ever be selected`,
    );
  }
}

/** Returns the validated shape kind so the caller can cross-check it against `durationSeconds`. */
function validateShape(c: IssueCollector, value: unknown, path: string): string | undefined {
  const obj = readObject(c, value, path, "a load shape");
  if (!obj) return undefined;

  const kind = readEnum(c, obj.kind, join(path, "kind"), SHAPE_KINDS);
  if (!kind) return undefined;

  switch (kind) {
    case "ramp": {
      rejectUnknownKeys(c, obj, path, ["kind", "direction", "fromRatePerSec", "toRatePerSec"]);
      const direction = readEnum(c, obj.direction, join(path, "direction"), RAMP_DIRECTIONS);
      const from = readNumber(c, obj.fromRatePerSec, join(path, "fromRatePerSec"), { min: 0 });
      const to = readNumber(c, obj.toRatePerSec, join(path, "toRatePerSec"), { min: 0 });
      // A "ramp up" whose rate falls (or vice versa) still compiles to a perfectly valid stage,
      // but the timeline renders it with the opposite glyph/colour — so flag the mismatch.
      if (direction !== undefined && from !== undefined && to !== undefined) {
        if (direction === "up" && to < from) {
          c.warn(path, `direction is "up" but the rate falls from ${from} to ${to} req/s`);
        }
        if (direction === "down" && to > from) {
          c.warn(path, `direction is "down" but the rate rises from ${from} to ${to} req/s`);
        }
      }
      break;
    }
    case "constant":
      rejectUnknownKeys(c, obj, path, ["kind", "ratePerSec"]);
      readNumber(c, obj.ratePerSec, join(path, "ratePerSec"), { min: 0 });
      break;
    case "spike":
      rejectUnknownKeys(c, obj, path, ["kind", "magnitudeRatePerSec"]);
      readNumber(c, obj.magnitudeRatePerSec, join(path, "magnitudeRatePerSec"), { min: 0 });
      break;
    case "sine":
    case "bell":
      rejectUnknownKeys(c, obj, path, ["kind", "peakRatePerSec"]);
      readNumber(c, obj.peakRatePerSec, join(path, "peakRatePerSec"), { min: 0 });
      break;
    case "individual":
      rejectUnknownKeys(c, obj, path, ["kind", "requestCount"]);
      readNumber(c, obj.requestCount, join(path, "requestCount"), { min: 0 });
      break;
  }

  return kind;
}

function validateLoad(
  c: IssueCollector,
  value: unknown,
  path: string,
  totalDurationSeconds: number | undefined,
  seenLoadIds: Map<string, string>,
): void {
  const obj = readObject(c, value, path, "a load");
  if (!obj) return;
  rejectUnknownKeys(c, obj, path, ["id", "startSeconds", "durationSeconds", "shape", "requests"]);

  const id = readString(c, obj.id, join(path, "id"), { nonEmpty: true });
  if (id !== undefined) {
    // Load ids key the per-load engine scenario and the per-request metric tags, so a duplicate
    // would silently merge two loads' results rather than just looking odd in the UI.
    const previous = seenLoadIds.get(id);
    if (previous !== undefined) {
      c.error(join(path, "id"), `duplicate load id "${id}" (already used at ${previous})`);
    } else {
      seenLoadIds.set(id, path);
    }
  }

  const start = readNumber(c, obj.startSeconds, join(path, "startSeconds"), { min: 0 });
  const duration = readNumber(c, obj.durationSeconds, join(path, "durationSeconds"), { min: 0 });
  const kind = validateShape(c, obj.shape, join(path, "shape"));
  validateRequestComposition(c, obj.requests, join(path, "requests"), `load "${id ?? "<unnamed>"}"`);

  if (kind !== undefined && duration !== undefined) {
    const instantaneous = !SUSTAINED_SHAPE_KINDS.includes(kind);
    if (instantaneous && duration !== 0) {
      c.warn(
        join(path, "durationSeconds"),
        `"${kind}" fires once rather than sustaining a rate, so durationSeconds should be 0 (got ${duration}); the engine will ignore it`,
      );
    }
    if (!instantaneous && duration === 0) {
      c.warn(join(path, "durationSeconds"), `"${kind}" sustains a rate over time, so a duration of 0 produces no requests`);
    }
  }

  if (start !== undefined && duration !== undefined && totalDurationSeconds !== undefined) {
    if (start + duration > totalDurationSeconds) {
      c.warn(
        path,
        `ends at ${start + duration}s, past the timeline's totalDurationSeconds of ${totalDurationSeconds}s; it will be cut short`,
      );
    }
  }
}

function validateTrack(
  c: IssueCollector,
  value: unknown,
  path: string,
  totalDurationSeconds: number | undefined,
  seenTrackIds: Map<string, string>,
  seenLoadIds: Map<string, string>,
): void {
  const obj = readObject(c, value, path, "a track");
  if (!obj) return;
  rejectUnknownKeys(c, obj, path, ["id", "label", "color", "loads"]);

  const id = readString(c, obj.id, join(path, "id"), { nonEmpty: true });
  if (id !== undefined) {
    const previous = seenTrackIds.get(id);
    if (previous !== undefined) {
      c.error(join(path, "id"), `duplicate track id "${id}" (already used at ${previous})`);
    } else {
      seenTrackIds.set(id, path);
    }
  }

  readString(c, obj.label, join(path, "label"));
  if (obj.color !== undefined) readString(c, obj.color, join(path, "color"), { nonEmpty: true });

  const loads = readArray(c, obj.loads, join(path, "loads"), "loads");
  if (!loads) return;
  loads.forEach((load, index) => validateLoad(c, load, join(join(path, "loads"), index), totalDurationSeconds, seenLoadIds));
}

/**
 * Non-throwing validation — returns every issue found, errors and warnings together, so a caller
 * can render them all at once instead of surfacing only the first failure.
 */
export function collectLoadTimelineIssues(input: unknown): ValidationIssue[] {
  const c = new IssueCollector();

  const root = readObject(c, input, "", "a LoadTimeline");
  if (!root) return c.issues;
  rejectUnknownKeys(c, root, "", ["totalDurationSeconds", "tracks"]);

  const totalDurationSeconds = readNumber(c, root.totalDurationSeconds, "totalDurationSeconds", { min: 0 });

  const tracks = readArray(c, root.tracks, "tracks", "tracks");
  if (tracks) {
    const seenTrackIds = new Map<string, string>();
    const seenLoadIds = new Map<string, string>();
    tracks.forEach((track, index) =>
      validateTrack(c, track, join("tracks", index), totalDurationSeconds, seenTrackIds, seenLoadIds),
    );
  }

  return c.issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

/**
 * Validates `input` and, if there are no errors, builds the real class instances from it.
 * Warnings never block — they are attached to the thrown error only when errors are present.
 *
 * @throws {TimelineValidationError} if the document has any `error`-severity issue.
 */
export function parseLoadTimeline(input: unknown): LoadTimeline {
  const issues = collectLoadTimelineIssues(input);
  if (hasErrors(issues)) throw new TimelineValidationError(issues);
  return LoadTimeline.fromJSON(input as LoadTimelineData);
}
