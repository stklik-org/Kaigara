import { useCallback, useEffect, useState } from "react";

export interface AsyncData<T> {
  /** `null` until the first load resolves. */
  data: T | null;
  /** Set when the most recent load rejected; cleared when a later one succeeds. */
  error: Error | null;
  /** Re-runs the loader and resolves once state has been updated — `await` it when a mutation has
   *  to be visible before the next step (see the Connect screen). */
  reload: () => Promise<void>;
}

/**
 * Loads data once per dependency change and drops the answer if it arrives after the component
 * stopped caring.
 *
 * Every screen here was hand-rolling the same `let cancelled = false` effect, and each copy is a
 * chance to forget the flag — which under React's StrictMode double-mount means the first (already
 * abandoned) request wins and writes stale data. Keeping one implementation makes that impossible
 * to get wrong in a screen.
 *
 * `deps` are the loader's inputs, exactly as for `useEffect`; `load` itself is intentionally not a
 * dependency, so callers can pass an inline closure without memoizing it.
 */
export function useAsyncData<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
    return () => {
      cancelled = true;
    };
    // `deps` is the caller's list, forwarded wholesale; the rule can only check literals in place.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, deps);

  return { data, error, reload };
}
