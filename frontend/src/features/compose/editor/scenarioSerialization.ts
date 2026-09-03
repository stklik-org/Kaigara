import {
  LoadTimeline,
  TimelineValidationError,
  collectLoadTimelineIssues,
  hasErrors,
  parseLoadTimeline,
  type ValidationIssue,
} from "@kaigara/shared-types";

/** Text ⇄ LoadTimeline, the two directions the Compose screen's Visual/Code views round-trip
 *  through. `toText` is the only writer of the document the editor shows; `parseText` is the only
 *  reader that is allowed to put one back into the store. */

export function toText(timeline: LoadTimeline): string {
  // JSON.stringify calls .toJSON() on the instance (and cascades into Track/Load/LoadShape's own
  // toJSON()) automatically — no manual serialization needed.
  return JSON.stringify(timeline, null, 2);
}

export type ParseResult =
  | { ok: true; timeline: LoadTimeline; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Non-throwing parse for the editor. Separates the two failure modes the user can actually be in
 * — "this isn't JSON yet, you're mid-keystroke" and "this is JSON but not a valid timeline" — and
 * returns *every* issue so the status bar can list them, rather than only the first.
 *
 * Warnings (a load that sends nothing, a load running past the end of the timeline) never block
 * the update: the document is still coherent, and refusing to sync it would make the Visual view
 * silently stop tracking the text.
 */
export function parseText(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ path: "", message: (error as Error).message, severity: "error" }] };
  }

  const issues = collectLoadTimelineIssues(parsed);
  if (hasErrors(issues)) return { ok: false, issues };

  return { ok: true, timeline: LoadTimeline.fromJSON(parsed as never), warnings: issues };
}

/**
 * Throwing variant, for callers that treat malformed input as a programming error rather than
 * something to render (e.g. loading a scenario file the app itself wrote).
 *
 * @throws {SyntaxError} if `text` is not JSON.
 * @throws {TimelineValidationError} if it is JSON but not a valid LoadTimeline.
 */
export function fromText(text: string): LoadTimeline {
  return parseLoadTimeline(JSON.parse(text));
}

export { TimelineValidationError };
export type { ValidationIssue };
