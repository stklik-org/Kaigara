/**
 * `localStorage` that cannot throw.
 *
 * Every browser storage access has three failure modes worth ignoring rather than reporting:
 * private-browsing mode (the API exists but throws), a full quota, and a value some earlier
 * version of the app wrote in a shape this one no longer understands. None of them is worth
 * interrupting the user over — the affected preference simply falls back to its default and still
 * works for the session — so the whole surface is funnelled through these helpers instead of
 * repeating a bare `try {} catch {}` at every call site.
 */

/** Reads a JSON value written by {@link writeJson}, or `null` if nothing usable is stored.
 *  `accept` decides whether the parsed value is still of the expected shape — a stored value that
 *  fails it is treated exactly like a missing one. */
export function readJson<T>(key: string, accept: (value: unknown) => value is T): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return accept(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full — the value still works for this session, just isn't remembered.
  }
}

/** Reads a plain string, narrowed by `accept` (typically a union of allowed literals). */
export function readString<T extends string>(key: string, accept: (value: string) => value is T): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw !== null && accept(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // See writeJson.
  }
}

/** Deletes a stored value. Used when what was stored is no longer valid (a draft written by an
 *  older build) or has been consumed. */
export function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // See writeJson.
  }
}

/** Reads a number that has to fall inside `[min, max]` — anything else (absent, unparseable, or
 *  out of the range the current build allows) falls back to the caller's default. */
export function readNumberInRange(key: string, min: number, max: number): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  } catch {
    return null;
  }
}
