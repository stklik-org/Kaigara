/**
 * Splits a Load across its own `RequestComposition`, by weight.
 *
 * The k6 adapter's `compileTimeline.ts` uses both halves: `weightShares` to scale a load's arrival
 * rate down to one script per request type, and `distribute` to split an `individual` load's
 * literal request count across those scripts so the parts add back up exactly (ADR 0005). Plain
 * arithmetic over authored weights, so it stays here in `timeline/` where any adapter could use it
 * (ADR 0004).
 */

/**
 * Normalises authored weights into shares that sum to 1.
 *
 * Weights are relative and need not sum to anything in particular (the authoring model says so
 * explicitly). A composition whose weights are all zero would otherwise divide by zero; it is
 * treated as uniform, and the validator has already warned the user that nothing could be selected.
 */
export function weightShares(weights: readonly number[]): number[] {
  const clamped = weights.map((weight) => Math.max(0, weight));
  const total = clamped.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? clamped.map((weight) => weight / total) : clamped.map(() => 1 / clamped.length);
}

/** Splits integer `total` across `fractions` (which sum to ~1) by largest remainder, so the parts
 *  add back up to `total` exactly. */
export function distribute(total: number, fractions: number[]): number[] {
  const raw = fractions.map((fraction) => total * fraction);
  const parts = raw.map(Math.floor);
  const remaining = total - parts.reduce((sum, part) => sum + part, 0);
  const byRemainder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining && i < byRemainder.length; i++) parts[byRemainder[i].index] += 1;
  return parts;
}
