/**
 * Turns an authored `LoadTimeline` into k6 scripts — the whole "translate the compose view into
 * actual requests" step, owned by the k6 adapter (ADR 0004). `K6Adapter.compile()` is the only
 * caller on the real run path; `RunService`'s two inspection-only endpoints (`/api/runs/compile`,
 * `/api/runs/concrete-plan`) import this module directly.
 *
 * All the thinking happens here, so the generated scripts can stay as simple as a hand-written one
 * (ADR 0005). Four steps:
 *
 *  1. **Validate** the document (`collectLoadTimelineIssues`).
 *  2. **Split** every load into one script per request type. The load's shape maps one to one onto
 *     a k6 executor (ADR 0002: `constant`/`spike` → `constant-arrival-rate`, `ramp` → a one-stage
 *     `ramping-arrival-rate`, `individual` → `shared-iterations`, `sine`/`bell` → stages sampled
 *     from `rateAt()`), scaled to that request type's weight share — a 70/30 read/create load at
 *     100 req/s becomes a 70 req/s read script and a 30 req/s create script. Each request type maps
 *     onto one IDTA-01002 call through `../../timeline/aasOperations.ts`.
 *  3. **Design the request pools** — decide, per script, the literal identifiers it addresses. The
 *     target is harvested once (`harvestIdentifiers.ts`), creates get freshly minted identifiers,
 *     and the scripts are walked in schedule order so each one addresses only what exists while it
 *     runs: an identifier created by a script whose window closed before this one starts, or found
 *     on the target — and not claimed by a delete that starts before this one ends.
 *  4. **Render** each script through its operation's template (`scriptTemplates.ts`), plus a thin
 *     `main.js` that schedules them all in one k6 process.
 *
 * Steps 1–2 are also exported on their own as `planTimeline()`: the concrete-plan view needs the
 * schedule, not identifiers, and should not contact the target to draw it.
 */

import {
  BellShape,
  ConstantShape,
  INSTANTANEOUS_WINDOW_SECONDS,
  IndividualShape,
  LoadTimeline,
  RampShape,
  SineShape,
  SpikeShape,
  collectLoadTimelineIssues,
  hasErrors,
  TimelineValidationError,
  type Load,
  type LoadTimelineData,
  type RequestSpec,
  type RequestTargetEntity,
  type ValidationIssue,
} from "@kaigara/shared-types";

import { describeOperation } from "../../timeline/aasOperations.ts";
import { distribute, weightShares } from "../../timeline/requestShares.ts";
import {
  DEFAULT_HARVEST_SIZE,
  EmptyServerCorpusError,
  httpHarvester,
  type IdentifierHarvester,
} from "./harvestIdentifiers.ts";
import {
  iterationBudget,
  planScripts,
  secondsToK6Duration,
  executorWindowSeconds,
  type ConstantArrivalRate,
  type IdentifierUse,
  type K6Plan,
  type PlanTarget,
  type PlannedBody,
  type PlannedExecutor,
  type PlannedIdentifiers,
  type PlannedLoad,
  type PlannedScript,
  type RampStage,
  type RampingArrivalRate,
  type RateTimeUnit,
} from "./k6Plan.ts";
import { renderMain, renderScript } from "./scriptTemplates.ts";

/**
 * How many `ramping-arrival-rate` stages a curved shape (sine, bell) is approximated with.
 * Piecewise-linear error falls off as 1/n²; at 16 stages a half-sine is reproduced to well under
 * a percent, far below the run-to-run variance of the thing being measured. Raising it mainly
 * costs k6-config size.
 */
const CURVE_SEGMENTS = 16;

/**
 * Round-trip time assumed when sizing an arrival-rate executor's worker pool (`ceil(rate ×
 * this)`). The real latency is exactly what the benchmark measures, so it cannot be known up
 * front — this is a deliberately generous starting estimate, and k6 reports `dropped_iterations`
 * when it turns out too low. That counter is surfaced in the run results, because a saturated
 * worker pool means the *tool* was the bottleneck, not the server under test.
 */
const ASSUMED_LATENCY_SECONDS = 0.25;
const MIN_PREALLOCATED_VUS = 1;
const MAX_PREALLOCATED_VUS = 500;
const MAX_VUS_CEILING = 2000;
/** Upper bound on the VUs a `shared-iterations` script fires its requests with. */
const MAX_INDIVIDUAL_VUS = 10;

/** Harvest cap for an `idPool.source: "server"` request that did not name one. High enough to be
 *  a corpus rather than a sample, low enough that the harvest is over in seconds. */
const DEFAULT_SERVER_MAX_IDS = 1000;

/** Spare identifiers minted per create script beyond its iteration budget. An arrival-rate
 *  executor can start one iteration more than `rate × duration` (it fires at both ends of the
 *  window), and a create that ran out of identifiers would have to skip; two spares cover it. */
const CREATE_ID_HEADROOM = 2;

/** Kaigara's own identifier namespace for entities a run creates, so a server operator sees one
 *  consistent prefix whichever scenario produced them. */
const ID_PREFIX: Record<RequestTargetEntity, string> = {
  shell: "https://kaigara.dev/ids/shell",
  submodel: "https://kaigara.dev/ids/submodel",
};

export interface CompileOptions {
  scenarioName?: string;
  target: PlanTarget;
  /** Where server identifiers come from. Defaults to paging the target's own collections; tests
   *  inject a fake. Only `compileTimeline` harvests — `planTimeline` never contacts the target. */
  harvest?: IdentifierHarvester;
  /** Fragment that makes this compile's minted identifiers unique. Defaults to a time-based
   *  nonce; tests pin it so the generated files are deterministic. */
  nonce?: string;
}

export interface PlanResult {
  plan: K6Plan;
  /** Non-blocking issues, forwarded so the caller can show the user *why* a run may not do what
   *  they expect: a load that sends nothing, a delete with nothing left to delete. */
  warnings: ValidationIssue[];
}

/** One generated file: `main.js` or one script it imports. */
export interface GeneratedFile {
  name: string;
  content: string;
}

export interface CompileResult extends PlanResult {
  /** `main.js` first, then one file per script in schedule order. */
  files: GeneratedFile[];
}

// ---------------------------------------------------------------------------------------------
// Step 2 — shape → executor, scaled per request type
// ---------------------------------------------------------------------------------------------

/** Engine scenario keys and metric tags have to survive shell quoting, JS identifiers and file
 *  names; authored ids are free-form strings, so they get folded down here. Uniqueness is
 *  guaranteed by the caller appending an index, not by this function. */
function sanitiseKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "load";
}

/** Sizes a k6 arrival-rate executor's VU pool from the peak rate it has to sustain. */
function sizeWorkerPool(peakRatePerSec: number): { preAllocatedVUs: number; maxVUs: number } {
  const estimated = Math.ceil(Math.max(0, peakRatePerSec) * ASSUMED_LATENCY_SECONDS);
  const preAllocatedVUs = Math.min(MAX_PREALLOCATED_VUS, Math.max(MIN_PREALLOCATED_VUS, estimated));
  const maxVUs = Math.min(MAX_VUS_CEILING, Math.max(preAllocatedVUs, preAllocatedVUs * 4));
  return { preAllocatedVUs, maxVUs };
}

/** Picks the `timeUnit` that expresses every one of `ratesPerSec` as a k6 integer: per second when
 *  they are all whole numbers, per minute otherwise (see `RateTimeUnit`). */
function rateUnit(ratesPerSec: number[]): { timeUnit: RateTimeUnit; toUnit: (ratePerSec: number) => number } {
  const whole = ratesPerSec.every((rate) => Math.abs(rate - Math.round(rate)) < 1e-9);
  const perUnit = whole ? 1 : 60;
  return { timeUnit: whole ? "1s" : "1m", toUnit: (ratePerSec) => Math.round(Math.max(0, ratePerSec) * perUnit) };
}

/** A flat rate held for a fixed window — the executor `constant` and `spike` both compile to. */
function constantRate(ratePerSec: number, durationSeconds: number): ConstantArrivalRate {
  const { timeUnit, toUnit } = rateUnit([ratePerSec]);
  return {
    executor: "constant-arrival-rate",
    rate: toUnit(ratePerSec),
    timeUnit,
    duration: secondsToK6Duration(durationSeconds),
    ...sizeWorkerPool(ratePerSec),
  };
}

/** A start rate plus linear legs, all in req/s — `ramp` is one leg, a sampled curve many. */
function rampingRate(startRatePerSec: number, legs: { ratePerSec: number; seconds: number }[]): RampingArrivalRate {
  const { timeUnit, toUnit } = rateUnit([startRatePerSec, ...legs.map((leg) => leg.ratePerSec)]);
  const stages: RampStage[] = legs.map((leg) => ({ target: toUnit(leg.ratePerSec), duration: secondsToK6Duration(leg.seconds) }));
  return {
    executor: "ramping-arrival-rate",
    startRate: toUnit(startRatePerSec),
    timeUnit,
    stages,
    ...sizeWorkerPool(Math.max(startRatePerSec, ...legs.map((leg) => leg.ratePerSec))),
  };
}

/**
 * Maps a Load's authored shape onto exactly one k6 executor, scaled to `share` of its rate — or,
 * for `individual`, firing exactly `iterations` requests.
 *
 * `instanceof`, not a `shape.kind === …` comparison — TypeScript narrows a class hierarchy on the
 * former only, and the rest of the codebase reads shape fields the same way (see shapeVisuals.ts).
 */
function planExecutor(load: Load, share: number, iterations: number): PlannedExecutor {
  const shape = load.shape;

  // "Individual" is a literal count of requests, not a rate — a rate curve cannot express "send
  // exactly three", and rounding one into existence would make the run non-reproducible.
  if (shape instanceof IndividualShape) {
    return {
      executor: "shared-iterations",
      vus: Math.max(1, Math.min(iterations, MAX_INDIVIDUAL_VUS)),
      iterations,
      maxDuration: secondsToK6Duration(INSTANTANEOUS_WINDOW_SECONDS),
    };
  }

  if (shape instanceof ConstantShape) return constantRate(shape.ratePerSec * share, load.durationSeconds);

  // A spike is instantaneous in the authoring model (durationSeconds 0); it runs as a flat rate
  // held for the same short window the Compose overlay previews it with.
  if (shape instanceof SpikeShape) return constantRate(shape.magnitudeRatePerSec * share, INSTANTANEOUS_WINDOW_SECONDS);

  if (shape instanceof RampShape) {
    // A ramp whose endpoints are equal is a constant — use the cheaper executor rather than a
    // one-stage ramp that interpolates between two identical rates.
    if (shape.fromRatePerSec === shape.toRatePerSec) return constantRate(shape.fromRatePerSec * share, load.durationSeconds);
    return rampingRate(shape.fromRatePerSec * share, [{ ratePerSec: shape.toRatePerSec * share, seconds: load.durationSeconds }]);
  }

  // k6 has no curved executor, so `sine`/`bell` are sampled through their own `rateAt()` into
  // linear stages — the one place the plan still approximates.
  if (shape instanceof SineShape || shape instanceof BellShape) {
    const step = load.durationSeconds / CURVE_SEGMENTS;
    const legs = Array.from({ length: CURVE_SEGMENTS }, (_, i) => ({
      ratePerSec: shape.rateAt((i + 1) * step, load.durationSeconds) * share,
      seconds: step,
    }));
    return rampingRate(shape.rateAt(0, load.durationSeconds) * share, legs);
  }

  throw new Error(`Unhandled LoadShape "${shape.kind}" — no k6 executor mapping.`);
}

/** Whether an executor would start any iteration at all — one that would not is never scheduled,
 *  because an idle k6 scenario is pure overhead competing with the load being measured. */
function issuesAnything(executor: PlannedExecutor): boolean {
  switch (executor.executor) {
    case "shared-iterations":
      return executor.iterations > 0;
    case "constant-arrival-rate":
      return executor.rate > 0;
    case "ramping-arrival-rate":
      return executor.startRate > 0 || executor.stages.some((stage) => stage.target > 0);
  }
}

/** The `id` an authored JSON body carries, if it is an object that has a string one. */
function identifierIn(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function planBody(spec: RequestSpec, sendsBody: boolean): PlannedBody {
  if (!sendsBody) return { kind: "none" };

  const generator = spec.generator.toJSON();
  switch (generator.kind) {
    case "randomized":
      return { kind: "randomized", sizeBytes: generator.sizeBytes };
    case "exact":
      return { kind: "exact", value: generator.value };
    case "mutate":
      // A base that is not a JSON object has no structure to mutate and no `id` to align with the
      // URL, so it is sent verbatim — which is exactly what an Exact body is, and is planned as one.
      return isJsonObject(generator.baseValue)
        ? { kind: "mutate", baseValue: generator.baseValue, mutationRatePercent: generator.mutationRatePercent }
        : { kind: "exact", value: generator.baseValue };
    default: {
      const unreachable: never = generator;
      throw new Error(`Unknown generator ${JSON.stringify(unreachable)}`);
    }
  }
}

/** How a script's generator will walk its identifier list — see `IdentifierUse`. */
function identifierUse(operation: RequestSpec["operation"], body: PlannedBody): IdentifierUse {
  switch (operation) {
    case "create":
      return body.kind === "exact" ? "none" : "mint";
    case "delete":
      return "each-once";
    case "read":
    case "update":
      return "cycle";
    case "query":
      return "none";
  }
}

function describeShape(load: Load): string {
  const shape = load.shape as unknown as Record<string, number | string>;
  switch (load.shape.kind) {
    case "ramp":
      return `${load.shape.label} ${shape.fromRatePerSec}→${shape.toRatePerSec} req/s`;
    case "constant":
      return `Constant ${shape.ratePerSec} req/s`;
    case "spike":
      return `Spike ${shape.magnitudeRatePerSec} req/s`;
    case "sine":
    case "bell":
      return `${load.shape.label} peak ${shape.peakRatePerSec} req/s`;
    case "individual":
      return `${shape.requestCount} individual request(s)`;
    default:
      return load.shape.label;
  }
}

/** A script before it is numbered: numbering waits until every load has been split, because files
 *  are numbered in schedule order across the whole timeline, not per track. */
type ScriptDraft = Omit<PlannedScript, "key" | "file"> & { order: number[] };

/**
 * Validates a timeline and splits it into the scripts that will run — steps 1 and 2. Identifier
 * lists are left empty; `compileTimeline` fills them in. Never contacts the target.
 *
 * @throws {TimelineValidationError} if the document has any error-severity issue — the backend
 * must never compile an unvalidated document into an engine script, since a `NaN` rate or a
 * missing `startSeconds` would surface as an incomprehensible engine failure much later.
 *
 * Deliberately does *not* reject a timeline that compiles to zero scripts — `/api/runs/compile`
 * and `/api/runs/concrete-plan` both show the user what a timeline does, and "nothing" is a
 * legitimate, inspectable answer there. `K6Adapter.compile()` is what refuses to *run* one
 * (`EmptyPlanError`), since that is the one caller for which an empty plan is actually a problem.
 */
export function planTimeline(input: LoadTimelineData | LoadTimeline, options: CompileOptions): PlanResult {
  const data: LoadTimelineData = input instanceof LoadTimeline ? input.toJSON() : input;

  const issues = collectLoadTimelineIssues(data);
  if (hasErrors(issues)) throw new TimelineValidationError(issues);

  const timeline = LoadTimeline.fromJSON(data);
  const loads: (Omit<PlannedLoad, "scripts"> & { drafts: ScriptDraft[] })[] = [];

  timeline.tracks.forEach((track, trackIndex) => {
    track.loads.forEach((load, loadIndex) => {
      const specs = load.requests.requests;
      // A load with no requests would compile into k6 scenarios that start workers and send
      // nothing — pure overhead (proposal section 2.3). The validator has already warned.
      if (specs.length === 0) return;

      const key = `${sanitiseKey(track.id)}__${sanitiseKey(load.id)}__${loadIndex}`;
      const shares = weightShares(specs.map((spec) => spec.weight));
      const total = load.shape instanceof IndividualShape ? Math.max(0, Math.round(load.shape.requestCount)) : 0;
      // An individual load's literal count is split by largest remainder, so the scripts' counts
      // add back up to exactly what was authored.
      const counts = distribute(total, shares);

      const drafts: ScriptDraft[] = [];
      specs.forEach((spec, requestIndex) => {
        const executor = planExecutor(load, shares[requestIndex], counts[requestIndex]);
        if (!issuesAnything(executor)) return;

        const descriptor = describeOperation(spec.operation, spec.target);
        const body = planBody(spec, descriptor.sendsBody);
        // An authored `idPool.source: "server"` only means anything where the operation addresses
        // an identifier at all; on a create or a collection read it is inert, and the validator
        // has already said so.
        const idSource =
          descriptor.idSource === "none" ? "none" : spec.idPool?.source === "server" ? "server" : "created";

        drafts.push({
          loadKey: key,
          requestId: spec.id,
          sourcePath: `tracks/${trackIndex}/loads/${loadIndex}/requests/requests/${requestIndex}`,
          operation: spec.operation,
          target: spec.target,
          method: descriptor.method,
          pathTemplate: descriptor.pathTemplate,
          query: descriptor.query,
          expectStatus: descriptor.expectStatus,
          body,
          idSource,
          ...(idSource === "server" ? { maxIds: spec.idPool?.maxIds ?? DEFAULT_SERVER_MAX_IDS } : {}),
          share: shares[requestIndex],
          startSeconds: load.startSeconds,
          endSeconds: load.startSeconds + executorWindowSeconds(executor),
          executor,
          expectedRequests: Math.round(iterationBudget(executor)),
          identifiers: { use: identifierUse(spec.operation, body), list: [], origin: "none", note: "" },
          order: [load.startSeconds, trackIndex, loadIndex, requestIndex],
        });
      });
      if (drafts.length === 0) return;

      loads.push({
        key,
        loadId: load.id,
        trackId: track.id,
        trackLabel: track.label,
        label: `${track.label} · ${describeShape(load)}`,
        shapeKind: load.shape.kind,
        startSeconds: load.startSeconds,
        executor: planExecutor(load, 1, total),
        expectedRequests: drafts.reduce((sum, draft) => sum + draft.expectedRequests, 0),
        drafts,
      });
    });
  });

  // Number every script in the order k6 will start it, so `ls` of a run directory reads as its
  // schedule and `main.js` lists its imports chronologically.
  const all = loads.flatMap((load) => load.drafts);
  all.sort((a, b) => a.order.reduce((diff, value, i) => diff || value - b.order[i], 0));
  const width = Math.max(2, String(all.length).length);
  const numbered = new Map<ScriptDraft, { key: string; file: string }>();
  all.forEach((draft, index) => {
    const number = String(index + 1).padStart(width, "0");
    numbered.set(draft, {
      key: `s${number}_${draft.operation}_${draft.target}`,
      file: `${number}-${draft.operation}-${draft.target}.js`,
    });
  });

  const plannedLoads: PlannedLoad[] = loads.map(({ drafts, ...load }) => ({
    ...load,
    scripts: drafts.map((draft) => {
      const { order, ...script } = draft;
      void order;
      return { ...(numbered.get(draft) as { key: string; file: string }), ...script };
    }),
  }));

  const plan: K6Plan = {
    version: 3,
    scenarioName: options.scenarioName?.trim() || "untitled-scenario",
    target: options.target,
    totalDurationSeconds: timeline.totalDurationSeconds,
    loads: plannedLoads,
    expectedRequests: plannedLoads.reduce((sum, load) => sum + load.expectedRequests, 0),
    harvested: { shell: 0, submodel: 0 },
  };

  return { plan, warnings: issues.filter((issue) => issue.severity === "warning") };
}

// ---------------------------------------------------------------------------------------------
// Step 3 — the request pools: which literal identifiers each script addresses
// ---------------------------------------------------------------------------------------------

/**
 * Harvests, once per entity, what any read/update/delete could fall back to. A `server`-sourced
 * request's own `maxIds` wins; anything else asks for one page, which only has to give a request
 * with nothing of its own to address something to fall back on.
 *
 * @throws {EmptyServerCorpusError} if an entity with an explicit `server`-sourced request harvests
 * to nothing — a benchmark against a corpus that does not exist measures nothing, and it is better
 * to say so before a script is even written than mid-run.
 */
async function harvestServerIds(
  scripts: PlannedScript[],
  harvest: IdentifierHarvester,
): Promise<Record<RequestTargetEntity, string[]>> {
  const server: Record<RequestTargetEntity, string[]> = { shell: [], submodel: [] };

  for (const entity of ["shell", "submodel"] as const) {
    const needing = scripts.filter((script) => script.target === entity && script.idSource !== "none");
    if (needing.length === 0) continue;

    const strict = needing.some((script) => script.idSource === "server");
    const maxIds = Math.max(DEFAULT_HARVEST_SIZE, ...needing.map((script) => script.maxIds ?? 0));
    server[entity] = await harvest(entity, maxIds);
    if (strict && server[entity].length === 0) throw new EmptyServerCorpusError(entity);
  }
  return server;
}

/** One identifier's life during the run, as far as compile time can know it. */
interface TrackedId {
  id: string;
  origin: "server" | "run";
  /** Seconds from run start from which it is known to exist: 0 for the target's own, the window
   *  end of the creating script for one this run creates. */
  existsFrom: number;
  /** Start of the delete script that removes it — from that moment on it may be gone. */
  deletedFrom?: number;
  /** File of the script that creates it. */
  createdBy?: string;
}

/** Whether `tracked` exists for the whole of `script`'s window: created before it starts, and not
 *  deleted before it ends. */
function aliveThroughout(tracked: TrackedId, script: PlannedScript): boolean {
  return (
    tracked.existsFrom <= script.startSeconds &&
    (tracked.deletedFrom === undefined || tracked.deletedFrom >= script.endSeconds)
  );
}

/** Up to `count` entries spread evenly across `items`, so a read that needs ten identifiers out of
 *  a thousand addresses the whole corpus rather than its first page. */
function evenlySpaced<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Which of `pool` a read/update/delete may address — by its `idSource` — and why. */
function candidatesFor(
  script: PlannedScript,
  pool: TrackedId[],
  alive: (tracked: TrackedId) => boolean,
): { ids: TrackedId[]; origin: PlannedIdentifiers["origin"]; note: string; fellBack: boolean } {
  const usable = pool.filter(alive);
  const fromServer = usable.filter((tracked) => tracked.origin === "server");
  if (script.idSource === "server") {
    return { ids: fromServer, origin: "server", note: "found on the target before the run", fellBack: false };
  }

  // "created" — this run's own, and only when there are none, whatever was on the target.
  const fromRun = usable.filter((tracked) => tracked.origin === "run");
  if (fromRun.length > 0) {
    const creators = [...new Set(fromRun.map((tracked) => tracked.createdBy))].join(", ");
    return { ids: fromRun, origin: "run", note: `created earlier in this run by ${creators}`, fellBack: false };
  }
  return {
    ids: fromServer,
    origin: fromServer.length > 0 ? "server" : "none",
    note: "found on the target before the run — nothing this run creates exists by the time it starts",
    fellBack: fromServer.length > 0,
  };
}

/**
 * Walks every script and decides its identifier list — the pool design (ADR 0005). Mutates the
 * scripts' `identifiers` in place and returns warnings for scripts that will skip requests.
 *
 * The model is load-granular and conservative, so that whatever a script addresses really exists:
 *
 *  - Creates first. Each gets `budget + CREATE_ID_HEADROOM` freshly minted identifiers; the ones
 *    it is expected to actually create exist from the moment its window closes. An Exact create
 *    creates the identifier its body names.
 *  - Deletes next, in start order. Each claims the identifiers it will remove — this run's own,
 *    oldest first, or (source `server`, or nothing of the run's exists) the target's — so no two
 *    deletes target the same entity and nothing later addresses what an earlier delete removed.
 *  - Reads and updates last, cycling over whatever is alive for their whole window.
 */
function designRequestPools(
  plan: K6Plan,
  server: Record<RequestTargetEntity, string[]>,
  nonce: string,
): ValidationIssue[] {
  const scripts = planScripts(plan);
  const loadLabel = new Map(plan.loads.map((load) => [load.key, load.label]));
  const describe = (script: PlannedScript) => `${script.file} (${loadLabel.get(script.loadKey)})`;
  const warnings: ValidationIssue[] = [];
  const warn = (script: PlannedScript, message: string) =>
    warnings.push({ path: script.sourcePath, severity: "warning", message: `${describe(script)}: ${message}` });

  const pools: Record<RequestTargetEntity, TrackedId[]> = {
    shell: server.shell.map((id) => ({ id, origin: "server", existsFrom: 0 })),
    submodel: server.submodel.map((id) => ({ id, origin: "server", existsFrom: 0 })),
  };
  const minted: Record<RequestTargetEntity, number> = { shell: 0, submodel: 0 };

  for (const script of scripts) {
    if (script.operation !== "create") continue;
    const budget = iterationBudget(script.executor);
    const expected = Math.floor(budget + 1e-9);

    if (script.body.kind === "exact") {
      // Sent verbatim every iteration: the body carries its own identifier (or deliberately none —
      // Exact is the negative-testing escape hatch), and nothing is minted for it.
      const id = identifierIn(script.body.value);
      if (id !== undefined && expected >= 1) {
        pools[script.target].push({ id, origin: "run", existsFrom: script.endSeconds, createdBy: script.file });
      }
      script.identifiers = {
        use: "none",
        list: [],
        origin: "none",
        note: id !== undefined ? `the Exact body's own identifier, ${id}` : "the Exact body, sent verbatim",
      };
      continue;
    }

    const count = Math.ceil(budget - 1e-9) + CREATE_ID_HEADROOM;
    const list = Array.from({ length: count }, () => `${ID_PREFIX[script.target]}/${nonce}-${minted[script.target]++}`);
    for (const id of list.slice(0, expected)) {
      pools[script.target].push({ id, origin: "run", existsFrom: script.endSeconds, createdBy: script.file });
    }
    script.identifiers = {
      use: "mint",
      list,
      origin: "minted",
      note: `minted for this run: ${expected} expected to be created, ${count - expected} spare`,
    };
  }

  /** A create on the same entity still running at some point during `script`'s window. */
  const concurrentCreate = (script: PlannedScript) =>
    scripts.find(
      (other) =>
        other.operation === "create" &&
        other.target === script.target &&
        other.startSeconds < script.endSeconds &&
        other.endSeconds > script.startSeconds,
    );
  const nothingExists = (script: PlannedScript, needed: number) => {
    const creating = concurrentCreate(script);
    return (
      `no ${script.target} is known to exist when it starts at +${script.startSeconds}s, so its ` +
      `~${plural(needed, "request")} will be skipped.` +
      (creating
        ? ` ${creating.file} is still creating ${script.target}s while it runs — a script only addresses ` +
          `identifiers that exist before it starts.`
        : ` Create ${script.target}s earlier in the timeline, or seed the target.`)
    );
  };

  for (const script of scripts) {
    if (script.operation !== "delete") continue;
    const needed = Math.ceil(iterationBudget(script.executor) - 1e-9);
    // Never one another delete has already claimed, whenever that delete runs.
    const candidates = candidatesFor(
      script,
      pools[script.target],
      (tracked) => tracked.deletedFrom === undefined && tracked.existsFrom <= script.startSeconds,
    );
    const claimed = candidates.ids.slice(0, needed);
    for (const tracked of claimed) tracked.deletedFrom = script.startSeconds;
    script.identifiers = { use: "each-once", list: claimed.map((tracked) => tracked.id), origin: candidates.origin, note: candidates.note };

    if (claimed.length === 0) {
      warn(script, nothingExists(script, needed));
    } else if (claimed.length < needed) {
      warn(
        script,
        `will start ~${plural(needed, "delete")}, but only ${plural(claimed.length, script.target)} ` +
          `${claimed.length === 1 ? "is" : "are"} known to exist at +${script.startSeconds}s; the other ` +
          `~${needed - claimed.length} iterations have nothing left to delete and are skipped.`,
      );
    }
    if (candidates.fellBack) {
      warn(
        script,
        `deletes ${plural(claimed.length, script.target)} that were already on the target, because nothing ` +
          `this run creates exists when it starts. Set its identifier source to "Existing on server" if ` +
          `that is intended.`,
      );
    }
  }

  for (const script of scripts) {
    if (script.operation !== "read" && script.operation !== "update") continue;
    const needed = Math.max(1, Math.ceil(iterationBudget(script.executor) - 1e-9));
    const candidates = candidatesFor(script, pools[script.target], (tracked) => aliveThroughout(tracked, script));
    const chosen = evenlySpaced(candidates.ids, needed);
    script.identifiers = { use: "cycle", list: chosen.map((tracked) => tracked.id), origin: candidates.origin, note: candidates.note };
    if (chosen.length === 0) warn(script, nothingExists(script, needed));
  }

  for (const script of scripts) {
    if (script.operation === "query") {
      script.identifiers = { use: "none", list: [], origin: "none", note: "a collection read — no identifier" };
    }
  }

  return warnings;
}

/** A short, compile-specific nonce so two compiles of the same scenario against the same target
 *  never mint identical identifiers — a collision would surface as a spurious 409. */
function mintNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validates and compiles a timeline into the files k6 runs: `main.js` plus one small script per
 * request type of every load, each carrying the literal identifiers it addresses.
 *
 * Contacts the target once per entity that some read/update/delete addresses (the harvest), and
 * otherwise nothing — the generated scripts discover no server state of their own.
 *
 * @throws {TimelineValidationError} for an invalid document (see `planTimeline`).
 * @throws {EmptyServerCorpusError} when an explicit `server`-sourced request finds nothing.
 */
export async function compileTimeline(input: LoadTimelineData | LoadTimeline, options: CompileOptions): Promise<CompileResult> {
  const { plan, warnings } = planTimeline(input, options);
  const scripts = planScripts(plan);

  const server = await harvestServerIds(scripts, options.harvest ?? httpHarvester(options.target));
  plan.harvested = { shell: server.shell.length, submodel: server.submodel.length };
  const poolWarnings = designRequestPools(plan, server, options.nonce ?? mintNonce());

  const loadByKey = new Map(plan.loads.map((load) => [load.key, load]));
  const files: GeneratedFile[] = [
    { name: "main.js", content: renderMain(plan) },
    ...scripts.map((script) => ({
      name: script.file,
      content: renderScript(script, loadByKey.get(script.loadKey) as PlannedLoad, plan),
    })),
  ];

  return { plan, files, warnings: [...warnings, ...poolWarnings] };
}
