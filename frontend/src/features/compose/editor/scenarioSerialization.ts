import {
  LoadTimeline,
  collectLoadTimelineIssues,
  hasErrors,
  type LoadTimelineData,
  type ValidationIssue,
} from "@kaigara/shared-types";

/** Text ⇄ LoadTimeline, the two directions the Compose screen's Visual and Code views round-trip
 *  through. `toText` is the only writer of the document the editor shows; `parseText` is the only
 *  reader allowed to put one back into the store. */

export function toText(timeline: LoadTimeline): string {
  // JSON.stringify calls .toJSON() on the instance and cascades into Track/Load/LoadShape's own
  // toJSON() — no manual serialization needed, and no second export shape to keep in sync.
  return JSON.stringify(timeline, null, 2);
}

export type ParseResult =
  | { ok: true; timeline: LoadTimeline; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Non-throwing parse for the editor. Separates the two failure modes the user can actually be in —
 * "this isn't JSON yet, you're mid-keystroke" and "this is JSON but not a valid timeline" — and
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

  // Safe by construction: `collectLoadTimelineIssues` reported no errors, which is exactly the
  // condition `fromJSON` assumes of its input.
  return { ok: true, timeline: LoadTimeline.fromJSON(parsed as LoadTimelineData), warnings: issues };
}
