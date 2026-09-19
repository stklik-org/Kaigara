/**
 * The k6 plan — a `LoadTimeline` lowered into a set of small k6 scripts. Entirely internal to
 * `engines/k6/`: per ADR 0004, no other module builds or consumes one. `RunService` hands an
 * adapter the authored timeline and gets back a thin `CompiledRunSummary` (`engines/adapter.ts`);
 * everything in between, including this type, is the k6 adapter's own business.
 *
 * Two levels, because the timeline is authored in one unit and executed in another (ADR 0005):
 *
 *  - `PlannedLoad` — one authored Load. Its shape maps one to one onto a k6 executor (ADR 0002);
 *    that full-rate executor is kept here for the summary views.
 *  - `PlannedScript` — one *request type* of one load: the load's executor scaled to that type's
 *    weight share, one IDTA-01002 call, and the literal list of identifiers it addresses. Each
 *    becomes one small, standalone k6 file (`scriptTemplates.ts`), and `main.js` schedules them all
 *    in a single k6 process.
 *
 * It stays a separate type from `LoadTimelineData`: the timeline is an *authoring* model (shapes,
 * tracks, colours) and this is an *execution* model (flat list of scripts, absolute rates,
 * resolved URLs, VU pools, concrete identifiers). Collapsing the two would put engine concerns
 * back into the document the user edits.
 */

import type { ExchangeCaptureData, RequestOperation, RequestTargetEntity } from "@kaigara/shared-types";
import type { ResolvedTarget } from "../adapter.ts";

/** The target this plan is aimed at — the same shape every adapter resolves a connection to,
 *  aliased under the name the rest of this k6-specific code already reads it as. */
export type PlanTarget = ResolvedTarget;

/**
 * Formats a second count as a k6 duration string: whole seconds as `"60s"`, anything else as
 * rounded integer milliseconds (`"2500ms"`), so a fractional curve stage never becomes a float
 * literal k6 has to parse loosely.
 */
export function secondsToK6Duration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  return Number.isInteger(clamped) ? `${clamped}s` : `${Math.round(clamped * 1000)}ms`;
}

/** Inverse of {@link secondsToK6Duration}, for views that summarise an already-compiled plan. */
export function k6DurationToSeconds(duration: string): number {
  if (duration.endsWith("ms")) return Number(duration.slice(0, -2)) / 1000;
  if (duration.endsWith("m")) return Number(duration.slice(0, -1)) * 60;
  if (duration.endsWith("s")) return Number(duration.slice(0, -1));
  return Number(duration);
}

/**
 * The unit an arrival rate is counted in. k6 rates are integers per `timeUnit`, so a whole number
 * of requests per second is written per second (`rate: 70, timeUnit: "1s"`), and anything else —
 * which a weight share makes common: a third of 10 req/s — per minute (`rate: 200, timeUnit: "1m"`),
 * which is exact to 1/60 req/s.
 */
export type RateTimeUnit = "1s" | "1m";

export function timeUnitSeconds(timeUnit: RateTimeUnit): number {
  return timeUnit === "1m" ? 60 : 1;
}

/**
 * One k6 executor configuration, minus the per-scenario fields (`startTime`, `exec`) that
 * `main.js` adds — each script exports it as `EXECUTOR`, and it spreads straight into
 * `options.scenarios[name]`.
 *
 * The three variants are k6's three relevant executors, and each authored shape maps to exactly
 * one of them:
 *  - `constant-arrival-rate` — a flat request rate held for a fixed window (`constant`, `spike`,
 *    and a degenerate `ramp` whose endpoints are equal).
 *  - `ramping-arrival-rate` — a start rate plus linear stages (`ramp` is one stage; `sine`/`bell`
 *    are `CURVE_SEGMENTS` stages sampled from `rateAt()`, since k6 has no curved executor).
 *  - `shared-iterations` — a literal iteration count fired once (`individual`), the only executor
 *    that guarantees "exactly N" rather than "≈N per second".
 */
export type PlannedExecutor = ConstantArrivalRate | RampingArrivalRate | SharedIterations;

export interface ConstantArrivalRate {
  executor: "constant-arrival-rate";
  /** Iterations started per `timeUnit`. */
  rate: number;
  timeUnit: RateTimeUnit;
  /** k6 duration string, e.g. `"60s"`. */
  duration: string;
  /** Worker pool sized at plan time as `ceil(rate × assumed latency)`, then bounded. */
  preAllocatedVUs: number;
  maxVUs: number;
}

export interface RampStage {
  /** Rate (per `timeUnit`) to reach by the end of this leg. */
  target: number;
  /** k6 duration string for the leg. */
  duration: string;
}

export interface RampingArrivalRate {
  executor: "ramping-arrival-rate";
  /** Rate at t=0, before the first stage. */
  startRate: number;
  timeUnit: RateTimeUnit;
  /** One leg per linear segment. `ramp` has exactly one; a sampled curve has `CURVE_SEGMENTS`. */
  stages: RampStage[];
  preAllocatedVUs: number;
  maxVUs: number;
}

export interface SharedIterations {
  executor: "shared-iterations";
  vus: number;
  iterations: number;
  /** Safety cap — the iterations are expected to complete well within it. */
  maxDuration: string;
}

/** Seconds an executor runs for: its duration, the sum of its stages, or its iteration cap. */
export function executorWindowSeconds(executor: PlannedExecutor): number {
  switch (executor.executor) {
    case "constant-arrival-rate":
      return k6DurationToSeconds(executor.duration);
    case "ramping-arrival-rate":
      return executor.stages.reduce((sum, stage) => sum + k6DurationToSeconds(stage.duration), 0);
    case "shared-iterations":
      return k6DurationToSeconds(executor.maxDuration);
  }
}

/**
 * How many iterations — i.e. requests — k6 will start for this executor if the target keeps up.
 * Read off the executor config itself rather than the authored shape, so it counts what k6 will
 * actually do after rates were rounded to integers per `timeUnit`. May be fractional for a ramp.
 */
export function iterationBudget(executor: PlannedExecutor): number {
  switch (executor.executor) {
    case "shared-iterations":
      return executor.iterations;
    case "constant-arrival-rate":
      return (executor.rate / timeUnitSeconds(executor.timeUnit)) * k6DurationToSeconds(executor.duration);
    case "ramping-arrival-rate": {
      let previous = executor.startRate;
      let total = 0;
      for (const stage of executor.stages) {
        total += ((previous + stage.target) / 2) * k6DurationToSeconds(stage.duration);
        previous = stage.target;
      }
      return total / timeUnitSeconds(executor.timeUnit);
    }
  }
}

/** Peak arrival rate in requests per second, or `undefined` for an iteration count. */
export function peakRatePerSecond(executor: PlannedExecutor): number | undefined {
  switch (executor.executor) {
    case "shared-iterations":
      return undefined;
    case "constant-arrival-rate":
      return executor.rate / timeUnitSeconds(executor.timeUnit);
    case "ramping-arrival-rate":
      return Math.max(executor.startRate, ...executor.stages.map((stage) => stage.target)) / timeUnitSeconds(executor.timeUnit);
  }
}

/** Rounds a req/s figure for display: whole numbers as-is, anything else to two decimals. */
function formatRate(ratePerSec: number): string {
  return Number.isInteger(ratePerSec) ? String(ratePerSec) : ratePerSec.toFixed(2).replace(/\.?0+$/, "");
}

/** One line of prose for an executor, e.g. "constant 70 req/s for 60s" — used in the generated
 *  files' headers and the concrete-plan view, so both describe a script in the same words. */
export function describeExecutor(executor: PlannedExecutor, shapeKind?: string): string {
  switch (executor.executor) {
    case "shared-iterations": {
      const within = Math.round(k6DurationToSeconds(executor.maxDuration));
      return `${executor.iterations} request${executor.iterations === 1 ? "" : "s"}, fired once within ~${within}s`;
    }
    case "constant-arrival-rate":
      return `constant ${formatRate(peakRatePerSecond(executor) ?? 0)} req/s for ${Math.round(executorWindowSeconds(executor))}s`;
    case "ramping-arrival-rate": {
      const unit = timeUnitSeconds(executor.timeUnit);
      const seconds = Math.round(executorWindowSeconds(executor));
      const endRate = (executor.stages.at(-1)?.target ?? executor.startRate) / unit;
      if (executor.stages.length === 1 || shapeKind === "ramp") {
        return `ramp ${formatRate(executor.startRate / unit)} → ${formatRate(endRate)} req/s over ${seconds}s`;
      }
      return `${shapeKind ?? "curve"}, ${executor.stages.length} stages peaking at ${formatRate(peakRatePerSecond(executor) ?? 0)} req/s over ${seconds}s`;
    }
  }
}

/** How a request body is produced at run time. Mirrors `RequestGeneratorData`, resolved to the
 *  fields an engine actually needs (the union is re-stated rather than imported so a change to
 *  the authoring model is a deliberate, visible change here too). */
export type PlannedBody =
  | { kind: "none" }
  /** `sizeBytesPool` is always populated (falling back to `[sizeBytes]` when the authored
   *  generator carried no real pool) so the script renderer never special-cases "no pool" — see
   *  `scriptTemplates.ts`'s `pickSizeBytes()`. */
  | { kind: "randomized"; sizeBytes: number; sizeBytesPool: number[] }
  | { kind: "exact"; value: string }
  | { kind: "mutate"; baseValue: string; mutationRatePercent: number };

/**
 * How a script's generator walks its identifier list:
 *
 *  - `none`      — the request addresses no identifier: a collection `query`, or an Exact create
 *                  whose body already carries its own.
 *  - `mint`      — a `create`: iteration i creates `list[i]`, each exactly once. The list was
 *                  minted for this run, with a little headroom over the iteration budget.
 *  - `each-once` — a `delete`: iteration i deletes `list[i]`, each exactly once. Iterations past
 *                  the end of the list have nothing left to delete and are counted as skipped.
 *  - `cycle`     — a `read`/`update`: iteration i addresses `list[i % list.length]`.
 */
export type IdentifierUse = "none" | "mint" | "each-once" | "cycle";

export interface PlannedIdentifiers {
  use: IdentifierUse;
  /** The literal identifiers, in the order the script addresses them. */
  list: string[];
  /** Where the list came from, for the generated header and the logs: entities found on the
   *  target at compile time, created earlier in this run, or minted for this script's creates. */
  origin: "none" | "server" | "run" | "minted";
  /** Human note on how the list was chosen, e.g. "created by k6_lifecycle_create_c.js". */
  note: string;
}

/** One request type of one load — the unit that becomes one generated k6 file. */
export interface PlannedScript {
  /** k6 scenario name and `main.js` export, e.g. `s03_read_shell`. Unique across the plan. */
  key: string;
  /** Generated file name: `k6_<track id>_<load id>_<request spec id>.js`, e.g.
   *  `k6_lifecycle_read_r.js`. Not numbered — `key` above carries the schedule position instead. */
  file: string;
  /** The owning `PlannedLoad.key` — also the `load` metric tag, so results roll up per load. */
  loadKey: string;
  /** RequestSpec id, carried through so results can be attributed back to the authored spec. */
  requestId: string;
  /** Where the authored spec sits in the timeline document, e.g. `tracks/0/loads/1/requests/requests/0`
   *  — the path compile warnings about this script point at. */
  sourcePath: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path relative to `PlanTarget.baseUrl`; `{id}` marks where a base64url identifier goes. */
  pathTemplate: string;
  /** Query parameters appended verbatim (e.g. the page size for a collection read). */
  query: Record<string, string>;
  /** Status codes counted as success. Anything else is an error in the run's results. */
  expectStatus: number[];
  body: PlannedBody;
  /**
   * Where the authored spec said identifiers come from: `none` (a read/update/delete addresses
   * none, or a create mints its own new one — the default), `created` (this run's own, falling
   * back to the target's), or `server` (only identifiers that were on the target before the run).
   * For a `create`, anything but `none` means it deliberately reuses an existing identifier rather
   * than minting one — see `RequestIdPoolData`'s own doc comment.
   */
  idSource: "none" | "created" | "server";
  /** For `idSource: "server"`: how many identifiers the compile-time harvest may page in. */
  maxIds?: number;
  /** For `idSource: "server"`: the authored `RequestIdPoolData.onEmpty` (default `"warn"` when the
   *  spec left it unset) — what `harvestServerIds` in compileTimeline.ts does if this script's
   *  entity harvests to nothing. Not meaningful for any other `idSource`. */
  onEmptyServerCorpus?: "warn" | "fail";
  /** This request type's normalised share of its load's weight, 0..1. */
  share: number;
  /** Offset from run start at which k6 starts this script, seconds. */
  startSeconds: number;
  /** When the script's executor window closes, seconds from run start. Anything it creates is
   *  addressable by scripts that start at or after this point. */
  endSeconds: number;
  executor: PlannedExecutor;
  /** Requests this script is expected to issue if the target keeps up (its iteration budget). */
  expectedRequests: number;
  identifiers: PlannedIdentifiers;
  /** For a `create`: the authored `RequestReferenceData` (requestComposition.ts) — which other
   *  entity's identifiers this script's body should embed, and how many per iteration. Only ever
   *  acted on for the one combination `scriptTemplates.ts` renders — see `references`'s own doc
   *  comment; otherwise carried through unused. */
  references?: { target: RequestTargetEntity; count: number };
  /** One group of already-existing identifiers per iteration, in iteration order — what
   *  `references` above resolved to once `designRequestPools` could see the referenced entity's
   *  pool. `[]` until then, and for every script without `references`. */
  referencedIds: string[][];
  /** For a `create` with `idSource: "none"` (i.e. minting, not reusing): the authored
   *  `RequestMintIdData` (requestComposition.ts) — the `<Num>`-templated format its new identifier
   *  should follow, in place of the engine's own opaque default. Undefined means that default. */
  mintId?: { format: string };
}

export interface PlannedLoad {
  /** Stable, filename/identifier-safe key unique across the plan. Also the metric tag that ties
   *  engine output back to this Load. */
  key: string;
  loadId: string;
  trackId: string;
  trackLabel: string;
  /** Human label for the run UI, e.g. "Base load · Constant 100 req/s". */
  label: string;
  shapeKind: string;
  startSeconds: number;
  /** The load's shape as one full-rate k6 executor (ADR 0002) — what the whole load does. Its
   *  `scripts` split exactly this by request share. Kept for the summary views. */
  executor: PlannedExecutor;
  /** Sum of the scripts' `expectedRequests`. */
  expectedRequests: number;
  scripts: PlannedScript[];
}

export interface K6Plan {
  /** Plan format version — bumped when the shape changes. `3` = one script per request type
   *  (ADR 0005); `2` was one executor per load with a weighted-random interpreter script. */
  version: 3;
  scenarioName: string;
  target: PlanTarget;
  totalDurationSeconds: number;
  loads: PlannedLoad[];
  /** Total requests the plan is expected to issue if the target keeps up. */
  expectedRequests: number;
  /** How many identifiers the compile-time harvest found on the target, per entity — `0` both
   *  where the target really is empty and where nothing needed a harvest at all. */
  harvested: Record<RequestTargetEntity, number>;
  /** The timeline's `capture` setting, with its default filled in — how much of each exchange the
   *  scripts log (`keepComplete()` in scriptTemplates.ts). */
  capture: ExchangeCaptureData;
}

/** Every script in the plan, in schedule order. Sorted by `key` (`s01_...`, `s02_...`, zero-padded
 *  to one width) rather than `file`: `file` is `<track>-<load>-<request spec>.js`, which reads as
 *  the timeline's own structure but does not sort chronologically, while `key` exists precisely to
 *  carry that order as a stable, sortable JS identifier — see compileTimeline.ts's numbering pass. */
export function planScripts(plan: K6Plan): PlannedScript[] {
  return plan.loads.flatMap((load) => load.scripts).sort((a, b) => a.key.localeCompare(b.key));
}

/** Placeholder written instead of a header value wherever a plan is serialised to disk or back to
 *  a client. The real values reach k6 only through its environment (`KAIGARA_HEADERS`). */
export const REDACTED = "<redacted>";

/** The plan as it may be written out or returned: identical, except that target header values —
 *  an Authorization bearer token, typically — are replaced by {@link REDACTED}. */
export function redactPlan(plan: K6Plan): K6Plan {
  const headers = Object.fromEntries(Object.keys(plan.target.headers).map((name) => [name, REDACTED]));
  return { ...plan, target: { ...plan.target, headers } };
}
