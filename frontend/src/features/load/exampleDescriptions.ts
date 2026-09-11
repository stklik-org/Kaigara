/**
 * Ready-made descriptions for the "Generate scenario from description" box on the Load screen.
 *
 * These are deliberately phrased the way someone would actually ask — fuzzy verbs ("read five
 * values", "inject a spike"), relative timing ("after 10 seconds") — because that fuzziness is
 * exactly what the LLM step has to resolve into (shape, operation, timing) triples. Each one is
 * chosen to exercise a different corner of the metamodel:
 *
 *  - `minimal`      — one-off `individual` loads, create/read/delete lifecycle, staggered starts
 *  - `steady-read`  — `ramp` up / `constant` hold / `ramp` down on a single track
 *  - `spike`        — a `constant` baseline with a `spike` injected partway through
 *  - `write-soak`   — two concurrent tracks (writes + queries) over a long window
 *  - `daily-curve`  — a `sine` hump plus a small `constant` background load
 *
 * The generator prompt ships a couple of these as few-shot pairs (description → known-good JSON),
 * so keep the wording stable — the examples and the gold documents are matched by hand.
 */
export interface ExampleDescription {
  id: string;
  /** Short label for the button. */
  label: string;
  /** The text dropped into the description box verbatim. */
  text: string;
}

export const EXAMPLE_DESCRIPTIONS: ExampleDescription[] = [
  {
    id: "minimal",
    label: "Minimal lifecycle",
    text: "Create a single AAS with three submodels, read five values after 10 seconds, then delete it again after 30 seconds.",
  },
  {
    id: "steady-read",
    label: "Steady read load",
    text: "Ramp up to 200 submodel reads per second over one minute, hold that rate for five minutes, then ramp back down to zero over one minute.",
  },
  {
    id: "spike",
    label: "Baseline + spike",
    text: "Run a steady 50 requests per second baseline of mixed shell reads and collection queries for 10 minutes, and inject a 1000 request-per-second spike five minutes in.",
  },
  {
    id: "write-soak",
    label: "Write-heavy soak",
    text: "For 30 minutes, create shells and submodels at 20 per second on one track while a second track continuously queries the shell collection at 100 per second, to see whether write throughput degrades over time.",
  },
  {
    id: "daily-curve",
    label: "Daily traffic curve",
    text: "Simulate a compressed work-day: a sine wave of shell and submodel queries peaking at 300 requests per second over a 30-minute run, on top of a small constant background load of 10 requests per second.",
  },
];
