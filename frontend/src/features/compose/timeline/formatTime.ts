export function formatMMSS(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Inverse of formatMMSS — accepts "m:ss" or a plain number of seconds. Returns null (rather than
 *  throwing/clamping) on anything unparseable, so callers can decide whether to reject the edit
 *  or fall back to the previous value. */
export function parseMMSS(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!trimmed.includes(":")) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || seconds < 0) return null;
  return minutes * 60 + seconds;
}
