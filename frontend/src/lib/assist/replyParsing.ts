/**
 * Shared handling of an LLM reply that is supposed to be one JSON object — used by both
 * `generateScenario.ts` (description → new timeline) and `editTimeline.ts` (instruction → edited
 * timeline).
 */

/** A user-facing failure in the assist pipeline (empty reply, non-JSON, invalid document). Its
 *  `message` is safe to show verbatim. */
export class AssistError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssistError";
  }
}

/** Pulls the first complete JSON object out of a model reply — tolerates a stray code fence or a
 *  sentence before/after despite the prompt forbidding both. */
export function extractJsonObject(reply: string): string {
  let text = reply.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf("{");
  if (start === -1) throw new AssistError("The model did not return any JSON.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new AssistError("The model's JSON response was cut off before it finished.");
}

export function parseReply(reply: string): unknown {
  const json = extractJsonObject(reply);
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new AssistError(`The model's reply was not valid JSON — ${(error as Error).message}`, { cause: error });
  }
}

/** Accepts the bare timeline the prompts ask for, and also unwraps a full scenario document if the
 *  model wrapped it in `phases.method` anyway. */
export function timelineDataFrom(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const method = (parsed as { phases?: { method?: unknown } }).phases?.method;
    if (method !== undefined) return method;
  }
  return parsed;
}
