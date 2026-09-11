/**
 * Browser-local autosave for the Compose timeline.
 *
 * The scenario being edited is mirrored to `localStorage` as it changes, so a reload — or a
 * return visit days later — resumes on the same document rather than an empty canvas, the way a
 * config editor keeps your unsaved edits. This is *not* the scenario library: nothing here writes
 * to the backend, and loading a library scenario simply overwrites the draft with it.
 *
 * `scenarioStore` boots its initial state from {@link readTimelineDraft} and calls
 * {@link writeTimelineDraft} (debounced) on every change; `App.tsx` reads the restored name to
 * decide whether "/" lands on Compose instead of Connect.
 */

import { LoadTimeline } from "@kaigara/shared-types";
import { readJson, remove, writeJson } from "@/lib/storage";
import { parseText } from "../editor/scenarioSerialization";

/** The stored-draft key. The `.v1` suffix is deliberate: a breaking metamodel change bumps it so
 *  old drafts are orphaned rather than fed to a parser that no longer understands them. */
const DRAFT_KEY = "kaigara.compose.timelineDraft.v1";

interface StoredDraft {
  name: string;
  /** `LoadTimeline.toJSON()` output — re-validated on read, never handed to `fromJSON` blindly. */
  timeline: unknown;
}

function isStoredDraft(value: unknown): value is StoredDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredDraft).name === "string" &&
    (value as StoredDraft).name.trim() !== "" &&
    "timeline" in value
  );
}

export interface RestoredDraft {
  name: string;
  timeline: LoadTimeline;
}

/**
 * The stored draft, or `null` when there is none or it no longer parses against the current
 * metamodel — in which case the stale entry is dropped so it can't keep failing on every load.
 * Goes through `parseText`, the same gate the Code view uses, so a draft that restores is a
 * document the editor itself would accept.
 */
export function readTimelineDraft(): RestoredDraft | null {
  const stored = readJson(DRAFT_KEY, isStoredDraft);
  if (!stored) return null;

  const result = parseText(JSON.stringify(stored.timeline));
  if (!result.ok) {
    remove(DRAFT_KEY);
    return null;
  }
  return { name: stored.name, timeline: result.timeline };
}

/** Persists the document currently being edited. `writeJson` cascades `timeline.toJSON()`, so the
 *  stored bytes are the same shape the Code view and `POST /api/runs` see. */
export function writeTimelineDraft(name: string, timeline: LoadTimeline): void {
  writeJson(DRAFT_KEY, { name, timeline } satisfies { name: string; timeline: LoadTimeline });
}

/** Forgets the stored draft. */
export function clearTimelineDraft(): void {
  remove(DRAFT_KEY);
}
