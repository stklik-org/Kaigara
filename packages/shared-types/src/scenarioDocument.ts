import { LoadTimeline } from "./loadTimeline.ts";
import { Scenario } from "./scenario.ts";
import { TimelineValidationError, parseLoadTimeline, type ValidationIssue } from "./loadTimelineValidation.ts";
import type { PhaseStep } from "./scenario.ts";

/**
 * The single reader for an untrusted *scenario* document, in the same spirit as
 * `loadTimelineValidation.ts` being the single reader for an untrusted timeline: the frontend's
 * drop zone and the backend's scenario-library folder both go through this, so a file the Load
 * screen accepts is exactly a file the library serves, and vice versa.
 *
 * Two document shapes are accepted:
 *
 *  - a full scenario object (`{ id?, name?, description?, connectionId?, phases: { method, … } }`), and
 *  - a bare method timeline (`{ totalDurationSeconds, tracks }`) — which is exactly what the
 *    Compose screen's Code view shows, so a document copied out of there loads straight back in.
 *
 * Validation of the method timeline is delegated wholesale to `parseLoadTimeline`. This module
 * only decides which of the two shapes it is looking at, and rewrites the failures into messages
 * naming the source. `filename` doubles as the fallback id/name for documents without one.
 */

/** Everything the caller could plausibly have been handed that is not a scenario, carrying a
 *  message meant to be shown verbatim. `issues` is populated when the document was well-formed
 *  JSON but failed timeline validation, so a UI can list the offending paths individually
 *  instead of only the summary line. Anything else escaping this module is a genuine bug. */
export class ScenarioFileError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ScenarioFileError";
    this.issues = issues;
  }
}

export function parseScenarioDocument(text: string, filename: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ScenarioFileError(`${filename} is not valid JSON — ${(error as Error).message}`);
  }
  return scenarioFromParsed(parsed, filename);
}

/** The already-parsed half of `parseScenarioDocument`, for callers holding a value rather than
 *  text (an HTTP body, say). */
export function scenarioFromParsed(parsed: unknown, filename: string): Scenario {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScenarioFileError(`${filename} does not contain a JSON object.`);
  }
  const doc = parsed as Record<string, unknown>;
  const phases = doc.phases;

  if (phases !== null && typeof phases === "object" && !Array.isArray(phases)) {
    return scenarioFromDocument(doc, phases as Record<string, unknown>, filename);
  }
  if ("tracks" in doc || "totalDurationSeconds" in doc) {
    return wrapTimeline(toTimeline(doc, filename), filename);
  }

  throw new ScenarioFileError(
    `${filename} doesn't look like a Kaigara scenario — expected either a scenario object with a "phases.method" timeline, or a bare method timeline with "totalDurationSeconds" and "tracks".`,
  );
}

function scenarioFromDocument(doc: Record<string, unknown>, phases: Record<string, unknown>, filename: string): Scenario {
  const fallback = fileStem(filename);
  return new Scenario({
    id: nonEmptyString(doc.id) ?? fallback,
    name: nonEmptyString(doc.name) ?? fallback,
    description: nonEmptyString(doc.description),
    connectionId: nonEmptyString(doc.connectionId),
    phases: {
      // Only the method phase is modelled (and edited) today — the other four are carried through
      // as opaque step lists, and default to empty so a file holding just a method still loads.
      preparation: steps(phases.preparation),
      preconditions: steps(phases.preconditions),
      method: toTimeline(phases.method, filename),
      postconditions: steps(phases.postconditions),
      cleanup: steps(phases.cleanup),
    },
  });
}

function wrapTimeline(method: LoadTimeline, filename: string): Scenario {
  const stem = fileStem(filename);
  return new Scenario({
    id: stem,
    name: stem,
    phases: { preparation: [], preconditions: [], method, postconditions: [], cleanup: [] },
  });
}

function toTimeline(value: unknown, filename: string): LoadTimeline {
  if (value === undefined) {
    throw new ScenarioFileError(`${filename} has no "phases.method" timeline.`);
  }
  try {
    return parseLoadTimeline(value);
  } catch (error) {
    if (error instanceof TimelineValidationError) {
      throw new ScenarioFileError(`${filename} is not a usable scenario.`, error.issues);
    }
    throw new ScenarioFileError(`${filename} is not a usable scenario — ${(error as Error).message}`);
  }
}

function steps(value: unknown): PhaseStep[] {
  return Array.isArray(value) ? (value as PhaseStep[]) : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** "recipes/component-manufacturer.json" -> "component-manufacturer". */
export function fileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.json$/i, "") || base;
}
