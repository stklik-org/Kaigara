/**
 * Renders an `ExecutionPlan` into a runnable k6 script.
 *
 * Shape of the generated file: the plan is embedded as a single JSON constant and interpreted by
 * a small fixed runtime, rather than unrolled into per-request code. That keeps the output short
 * enough for a user to actually read — the translation from timeline to HTTP requests should be
 * inspectable, which is why `POST /api/runs/compile` hands this script back — and it keeps the
 * generator itself free of string-concatenated JavaScript, which is where codegen bugs live.
 *
 * k6 is invoked strictly as an external subprocess and never linked, so its AGPL-3.0 licence does
 * not reach the rest of the codebase (proposal sections 3.1 and 12). Nothing in this file imports
 * k6; it only writes text that k6 will later read.
 */

import type { ExecutionPlan, PlannedLoad } from "../../timeline/executionPlan.ts";

export interface ScriptOptions {
  /**
   * Round-trip time assumed when sizing the worker pool, in seconds.
   *
   * An arrival-rate executor needs enough VUs to keep issuing requests while earlier ones are
   * still in flight: roughly `rate × latency`. The real latency is precisely what the benchmark
   * is measuring, so it cannot be known up front — this is a starting estimate, deliberately
   * generous, and k6 reports `dropped_iterations` if it turns out too low. That counter is
   * surfaced in the run results because a saturated worker pool means the *tool* was the
   * bottleneck, not the server, which silently invalidates the numbers.
   */
  assumedLatencySeconds?: number;
  /** Absolute path k6 should write its end-of-run summary to. */
  summaryPath: string;
  /** How many existing identifiers to page in at setup for update/delete to work against. */
  seedPoolSize?: number;
}

const DEFAULT_ASSUMED_LATENCY_SECONDS = 0.25;
const DEFAULT_SEED_POOL_SIZE = 100;
const MIN_PREALLOCATED_VUS = 1;
const MAX_PREALLOCATED_VUS = 500;
const MAX_VUS_CEILING = 2000;
/** Bound on the per-VU pool of self-created identifiers, so a long write-heavy run cannot grow
 *  the engine's own memory without limit while it is meant to be measuring someone else's. */
const CREATED_POOL_LIMIT = 200;

function millis(seconds: number): string {
  return `${Math.max(0, Math.round(seconds * 1000))}ms`;
}

/** Shifts every line but the first by `levels` × 2 spaces, so a JSON blob substituted into the
 *  middle of the generated file lines up with the code around it. */
function indent(text: string, levels: number): string {
  const pad = "  ".repeat(levels);
  return text.split("\n").join(`\n${pad}`);
}

function sizeWorkerPool(peakRatePerSec: number, assumedLatencySeconds: number): { preAllocatedVUs: number; maxVUs: number } {
  const estimated = Math.ceil(peakRatePerSec * assumedLatencySeconds);
  const preAllocatedVUs = Math.min(MAX_PREALLOCATED_VUS, Math.max(MIN_PREALLOCATED_VUS, estimated));
  const maxVUs = Math.min(MAX_VUS_CEILING, Math.max(preAllocatedVUs, preAllocatedVUs * 4));
  return { preAllocatedVUs, maxVUs };
}

/** The exported k6 function name a scenario's `exec` points at. */
export function execNameFor(load: PlannedLoad): string {
  return `load_${load.key}`;
}

type K6Scenario = Record<string, unknown>;

/**
 * Maps one planned load onto a k6 executor.
 *
 * The three cases are genuinely different execution models, not cosmetic variants:
 *  - a flat rate is a `constant-arrival-rate` (cheaper: no per-stage interpolation),
 *  - a curve is a `ramping-arrival-rate` whose stages are the plan's linear segments,
 *  - a literal request count is `shared-iterations`, which is the only executor that guarantees
 *    "exactly N requests" rather than "N per second, roughly".
 *
 * Returns null for a load that would issue nothing, so it never becomes an idle k6 scenario.
 */
function scenarioFor(load: PlannedLoad, options: Required<Pick<ScriptOptions, "assumedLatencySeconds">>): K6Scenario | null {
  const common = {
    startTime: millis(load.startSeconds),
    exec: execNameFor(load),
    tags: { load: load.key, track: load.trackId },
  };

  if (load.execution.mode === "fixed") {
    const { iterations, withinSeconds } = load.execution;
    if (iterations <= 0) return null;
    return {
      ...common,
      executor: "shared-iterations",
      vus: Math.min(iterations, 10),
      iterations,
      maxDuration: millis(withinSeconds),
    };
  }

  const { profile } = load.execution;
  if (profile.durationSeconds <= 0 || profile.peakRatePerSec <= 0) return null;

  const { preAllocatedVUs, maxVUs } = sizeWorkerPool(profile.peakRatePerSec, options.assumedLatencySeconds);

  if (profile.flat) {
    const rate = Math.round(profile.startRatePerSec);
    if (rate <= 0) return null;
    return {
      ...common,
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: millis(profile.durationSeconds),
      preAllocatedVUs,
      maxVUs,
    };
  }

  return {
    ...common,
    executor: "ramping-arrival-rate",
    startRate: Math.round(profile.startRatePerSec),
    timeUnit: "1s",
    preAllocatedVUs,
    maxVUs,
    stages: profile.segments.map((segment) => ({
      target: Math.round(segment.toRatePerSec),
      duration: millis(segment.durationSeconds),
    })),
  };
}

/**
 * The fixed part of the generated script. Kept as one literal so it reads as the JavaScript it is
 * — and so that changing engine behaviour is a diff in real code, not in escaped fragments.
 *
 * `__PLAN__`, `__SUMMARY_PATH__`, `__SEED_POOL_SIZE__`, `__NEEDS_POOL__` and `__SCENARIOS__` are
 * substituted below. They are the only interpolation points.
 */
const RUNTIME = String.raw`
import http from "k6/http";
import { check } from "k6";
import encoding from "k6/encoding";
import { Counter } from "k6/metrics";

// ---------------------------------------------------------------------------------------------
// Plan — compiled from the scenario's timeline. Every request this script can issue is described
// here; the code below only interprets it.
// ---------------------------------------------------------------------------------------------
const PLAN = __PLAN__;
const SEED_POOL_SIZE = __SEED_POOL_SIZE__;
const NEEDS_POOL = __NEEDS_POOL__;
const CREATED_POOL_LIMIT = __CREATED_POOL_LIMIT__;

const LOADS = {};
for (const load of PLAN.loads) LOADS[load.key] = load;

// Tag for the tool's own bookkeeping requests (pool seeding in setup()). They are Kaigara asking
// the server a question on its own behalf, not part of the workload being measured, so the
// results parser drops anything carrying this tag — otherwise the tool's own overhead would show
// up in the numbers it exists to report.
const SETUP_TAG = "__kaigara_setup";

// Requests that could not be issued because no identifier was available to address. Counted
// rather than silently skipped: a delete-heavy load against an empty server would otherwise look
// like a clean run that simply did less work than asked.
const skippedNoId = new Counter("kaigara_skipped_no_id");

// k6's own "expected_response" tag drives the failure rate in the output we parse. By default it
// means "2xx or 3xx", which would misreport a 201 or a deliberate negative test; binding it to the
// plan's own expected statuses makes the tag authoritative.
const RESPONSE_CALLBACKS = {};
for (const load of PLAN.loads) {
  RESPONSE_CALLBACKS[load.key] = load.requests.map((request) => http.expectedStatuses(...request.expectStatus));
}

// Identifiers this VU created itself. Module scope in k6 is per-VU, so this is a VU-local pool
// with no cross-VU coordination — deliberate: sharing it would need a lock on the hot path.
const created = { shell: [], submodel: [] };

export const options = {
  scenarios: __SCENARIOS__,
  // The tool's own summary rendering is not needed; results are parsed from the JSON stream.
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

// ---------------------------------------------------------------------------------------------
// Setup: page in identifiers that already exist on the target, so update/delete have something to
// address on a server this run did not populate itself.
// ---------------------------------------------------------------------------------------------
export function setup() {
  const pools = { shell: [], submodel: [] };
  if (!NEEDS_POOL) return pools;

  const paths = { shell: "/shells", submodel: "/submodels" };
  for (const entity of Object.keys(paths)) {
    const url = PLAN.target.baseUrl + paths[entity] + "?limit=" + SEED_POOL_SIZE;
    const response = http.get(url, {
      headers: PLAN.target.headers,
      timeout: PLAN.target.timeoutSeconds + "s",
      tags: { load: SETUP_TAG },
    });
    if (response.status !== 200) continue;
    let body = null;
    try {
      body = response.json();
    } catch (err) {
      continue;
    }
    // IDTA-01002 paged collection responses are { result: [...], paging_metadata: {...} }.
    const items = body && Array.isArray(body.result) ? body.result : [];
    pools[entity] = items.map((item) => item && item.id).filter((id) => typeof id === "string");
  }
  return pools;
}

function b64url(value) {
  // IDTA-01002 puts identifiers in path segments base64url-encoded, unpadded.
  return encoding.b64encode(value, "rawurl");
}

function randomSuffix() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function filler(length) {
  if (length <= 0) return "";
  let out = "";
  while (out.length < length) out += "kaigara-payload-filler-";
  return out.slice(0, length);
}

// Payloads are shaped as real IDTA-01001 entities rather than opaque blobs: a server that
// validates its input must be able to accept them, or the benchmark would only ever measure the
// rejection path. Padding to the requested size goes into a legitimate field.
function randomShell(sizeBytes) {
  const suffix = randomSuffix();
  const shell = {
    modelType: "AssetAdministrationShell",
    id: "https://kaigara.dev/ids/shell/" + suffix,
    idShort: "shell_" + suffix.replace(/[^a-zA-Z0-9]/g, "_"),
    assetInformation: { assetKind: "Instance", globalAssetId: "https://kaigara.dev/ids/asset/" + suffix },
  };
  const pad = sizeBytes - JSON.stringify(shell).length;
  if (pad > 0) shell.description = [{ language: "en", text: filler(pad) }];
  return shell;
}

function randomSubmodel(sizeBytes) {
  const suffix = randomSuffix();
  const submodel = {
    modelType: "Submodel",
    id: "https://kaigara.dev/ids/submodel/" + suffix,
    idShort: "submodel_" + suffix.replace(/[^a-zA-Z0-9]/g, "_"),
    submodelElements: [
      { modelType: "Property", idShort: "generatedAt", valueType: "xs:string", value: new Date().toISOString() },
    ],
  };
  const pad = sizeBytes - JSON.stringify(submodel).length;
  if (pad > 0) {
    submodel.submodelElements.push({ modelType: "Property", idShort: "payload", valueType: "xs:string", value: filler(pad) });
  }
  return submodel;
}

function randomEntity(target, sizeBytes) {
  return target === "shell" ? randomShell(sizeBytes) : randomSubmodel(sizeBytes);
}

// Walks a parsed payload and rewrites a share of its leaf values — "mutate" sits between Exact
// (no variation) and Randomized (no fixed structure), so the structure must survive.
function mutateInPlace(node, ratePercent) {
  if (Array.isArray(node)) {
    for (const child of node) mutateInPlace(child, ratePercent);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value !== null && typeof value === "object") {
      mutateInPlace(value, ratePercent);
    } else if (Math.random() * 100 < ratePercent) {
      if (typeof value === "number") node[key] = value + Math.round(Math.random() * 100);
      else if (typeof value === "string") node[key] = value + "-" + randomSuffix();
    }
  }
}

function buildBody(request, id) {
  const spec = request.body;
  if (spec.kind === "none") return null;

  if (spec.kind === "exact") {
    // Sent verbatim, including an id that may not match the URL. "Exact" is the negative-testing
    // escape hatch (proposal section 9.1 asks for deliberately invalid instances), so silently
    // repairing it here would remove the only way to author such a case.
    return spec.value;
  }

  let payload;
  if (spec.kind === "randomized") {
    payload = randomEntity(request.target, spec.sizeBytes);
  } else {
    try {
      payload = JSON.parse(spec.baseValue);
    } catch (err) {
      return spec.baseValue;
    }
    mutateInPlace(payload, spec.mutationRatePercent);
  }

  // A PUT to /submodels/{id} whose body carries a different id is rejected by conformant servers.
  // The generated payloads are ours to align, so align them.
  if (id !== null && payload && typeof payload === "object") payload.id = id;
  return JSON.stringify(payload);
}

function pickRequest(load) {
  const draw = Math.random();
  const requests = load.requests;
  for (let i = 0; i < requests.length; i++) {
    if (draw < requests[i].cumulativeWeight) return i;
  }
  return requests.length - 1;
}

function takeId(target, seeded, consumes) {
  const mine = created[target];
  if (mine.length > 0) {
    const index = Math.floor(Math.random() * mine.length);
    const id = mine[index];
    if (consumes) mine.splice(index, 1);
    return id;
  }
  const pool = seeded && seeded[target] ? seeded[target] : [];
  if (pool.length === 0) return null;
  // Seeded ids are shared across VUs and not ours to remove from, so a consuming operation may
  // race another VU onto the same id. That surfaces honestly as a 404 in the results rather than
  // being hidden, which is the correct reading: the server really was asked to delete it twice.
  return pool[Math.floor(Math.random() * pool.length)];
}

function remember(target, body) {
  if (!body) return;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return;
  }
  if (!parsed || typeof parsed.id !== "string") return;
  const pool = created[target];
  pool.push(parsed.id);
  if (pool.length > CREATED_POOL_LIMIT) pool.shift();
}

function execute(loadKey, seeded) {
  const load = LOADS[loadKey];
  const index = pickRequest(load);
  const request = load.requests[index];

  let id = null;
  if (request.idSource === "pool") {
    id = takeId(request.target, seeded, request.consumesId);
    if (id === null) {
      skippedNoId.add(1, { load: loadKey, op: request.operation, target: request.target });
      return;
    }
  }

  let path = request.pathTemplate;
  if (id !== null) path = path.replace("{id}", b64url(id));

  let url = PLAN.target.baseUrl + path;
  const queryKeys = Object.keys(request.query);
  if (queryKeys.length > 0) {
    url += "?" + queryKeys.map((key) => key + "=" + encodeURIComponent(request.query[key])).join("&");
  }

  const body = buildBody(request, id);
  const headers = Object.assign({ accept: "application/json" }, PLAN.target.headers);
  if (body !== null) headers["content-type"] = "application/json";

  const response = http.request(request.method, url, body, {
    headers: headers,
    timeout: PLAN.target.timeoutSeconds + "s",
    responseCallback: RESPONSE_CALLBACKS[loadKey][index],
    tags: { load: loadKey, track: load.trackId, op: request.operation, target: request.target },
  });

  const ok = request.expectStatus.indexOf(response.status) !== -1;
  check(response, { "status as specified": () => ok }, { load: loadKey, op: request.operation });

  if (ok && request.operation === "create") remember(request.target, body);
}

export function handleSummary(data) {
  const out = {};
  out[__SUMMARY_PATH__] = JSON.stringify(data);
  return out;
}
`;

/**
 * Generates the complete k6 script for `plan`.
 *
 * The returned string is written to the run's working directory and handed to `k6 run`; it is
 * also what `POST /api/runs/compile` returns, so treat it as user-facing output.
 */
export function compileK6Script(plan: ExecutionPlan, options: ScriptOptions): string {
  const assumedLatencySeconds = options.assumedLatencySeconds ?? DEFAULT_ASSUMED_LATENCY_SECONDS;
  const seedPoolSize = options.seedPoolSize ?? DEFAULT_SEED_POOL_SIZE;

  const scenarios: Record<string, K6Scenario> = {};
  const executed: PlannedLoad[] = [];

  for (const load of plan.loads) {
    const scenario = scenarioFor(load, { assumedLatencySeconds });
    if (!scenario) continue;
    scenarios[load.key] = scenario;
    executed.push(load);
  }

  // Only page in existing identifiers when something actually addresses one; otherwise setup
  // would issue two pointless requests against the server under test before the run begins.
  const needsPool = executed.some((load) => load.requests.some((request) => request.idSource === "pool"));

  const header = [
    "// GENERATED BY KAIGARA — do not edit.",
    "//",
    `// Scenario:  ${plan.scenarioName}`,
    `// Target:    ${plan.target.baseUrl}`,
    `// Timeline:  ${plan.totalDurationSeconds}s, ${plan.loads.length} load(s), ${executed.length} executable`,
    `// Expected:  ~${plan.expectedRequests} requests if the target keeps up`,
    "//",
    "// Every request below is an IDTA-01002 REST call. This file is executed by the k6 binary as",
    "// an external subprocess; k6 is never linked into Kaigara (proposal sections 3.1 and 12).",
  ].join("\n");

  const wrappers = executed
    .map(
      (load) =>
        `// ${load.label}\nexport function ${execNameFor(load)}(data) {\n  execute(${JSON.stringify(load.key)}, data);\n}`,
    )
    .join("\n\n");

  const body = RUNTIME.replace("__PLAN__", JSON.stringify({ target: plan.target, loads: executed }, null, 2))
    // Indented one level, because it is substituted as the value of `scenarios:` inside the
    // options object — this file is shown to users, so it should read like hand-written code.
    .replace("__SCENARIOS__", indent(JSON.stringify(scenarios, null, 2), 1))
    .replace("__SEED_POOL_SIZE__", String(seedPoolSize))
    .replace("__NEEDS_POOL__", String(needsPool))
    .replace("__CREATED_POOL_LIMIT__", String(CREATED_POOL_LIMIT))
    .replace("__SUMMARY_PATH__", JSON.stringify(options.summaryPath));

  return `${header}\n${body}\n// -------------------------------------------------------------------------------------------\n// One exported entry point per load — k6 scenarios reference these by name via \`exec\`.\n// -------------------------------------------------------------------------------------------\n\n${wrappers}\n`;
}
