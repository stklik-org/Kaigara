import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";

import {
  BellShape,
  ConstantShape,
  ExactGenerator,
  IndividualShape,
  Load,
  LoadTimeline,
  MutateGenerator,
  RampShape,
  RandomizedGenerator,
  RequestComposition,
  RequestSpec,
  SineShape,
  SpikeShape,
  Track,
  TimelineValidationError,
  INSTANTANEOUS_WINDOW_SECONDS,
  type RequestTargetEntity,
} from "@kaigara/shared-types";

import { compileTimeline, planTimeline, type GeneratedFile } from "../src/engines/k6/compileTimeline.ts";
import { EmptyServerCorpusError, httpHarvester, type IdentifierHarvester } from "../src/engines/k6/harvestIdentifiers.ts";
import { iterationBudget, planScripts, type K6Plan, type PlannedScript } from "../src/engines/k6/k6Plan.ts";
import { HEADERS_ENV } from "../src/engines/k6/scriptTemplates.ts";
import { describeOperation } from "../src/timeline/aasOperations.ts";

const TARGET = { baseUrl: "http://127.0.0.1:8081/", timeoutSeconds: 30, headers: {} };

/** A target with nothing on it — the default for tests that only care about the schedule. */
const emptyTarget: IdentifierHarvester = async () => [];

/** A target holding exactly these identifiers, honouring the requested cap like a real one. */
function targetWith(corpus: Partial<Record<RequestTargetEntity, string[]>>): IdentifierHarvester {
  return async (entity, maxIds) => (corpus[entity] ?? []).slice(0, maxIds);
}

/** Compiles with a stub target, and a pinned nonce so minted identifiers are predictable. */
function compile(timeline: LoadTimeline, harvest: IdentifierHarvester = emptyTarget) {
  return compileTimeline(timeline, { target: TARGET, scenarioName: "test", harvest, nonce: "nonce" });
}

function spec(
  id: string,
  operation: RequestSpec["operation"],
  target: RequestSpec["target"],
  weight: number,
  idPool?: RequestSpec["idPool"],
): RequestSpec {
  return new RequestSpec({
    id,
    operation,
    target,
    weight,
    generator: new RandomizedGenerator({ sizeBytes: 128 }),
    ...(idPool ? { idPool } : {}),
  });
}

function timelineWith(...tracks: Track[]): LoadTimeline {
  return new LoadTimeline({ totalDurationSeconds: 600, tracks });
}

function track(id: string, ...loads: Load[]): Track {
  return new Track({ id, label: id, loads });
}

function load(
  id: string,
  startSeconds: number,
  durationSeconds: number,
  shape: ConstructorParameters<typeof Load>[0]["shape"],
  ...requests: RequestSpec[]
): Load {
  return new Load({ id, startSeconds, durationSeconds, shape, requests: new RequestComposition(requests) });
}

function singleLoad(shape: ConstructorParameters<typeof Load>[0]["shape"], durationSeconds: number, startSeconds = 0): LoadTimeline {
  return timelineWith(track("t1", load("l1", startSeconds, durationSeconds, shape, spec("r1", "query", "shell", 1))));
}

/** The one script of a single-request timeline. */
function onlyScript(plan: K6Plan): PlannedScript {
  const scripts = planScripts(plan);
  assert.equal(scripts.length, 1, "expected exactly one script");
  return scripts[0];
}

// ---------------------------------------------------------------------------------------------
// Shape → executor (ADR 0002). The load-level executor is the shape at full rate; each script
// carries the same executor scaled to its request type's share.
// ---------------------------------------------------------------------------------------------

test("a ramp maps directly to a one-stage ramping-arrival-rate executor", () => {
  const { plan } = planTimeline(singleLoad(new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 120 }), 60), {
    target: TARGET,
  });

  assert.deepEqual(plan.loads[0].executor, {
    executor: "ramping-arrival-rate",
    startRate: 0,
    timeUnit: "1s",
    stages: [{ target: 120, duration: "60s" }],
    preAllocatedVUs: 30,
    maxVUs: 120,
  });
});

test("a constant load maps directly to a single constant-arrival-rate executor", () => {
  const { plan } = planTimeline(singleLoad(new ConstantShape({ ratePerSec: 100 }), 60), { target: TARGET });

  assert.deepEqual(plan.loads[0].executor, {
    executor: "constant-arrival-rate",
    rate: 100,
    timeUnit: "1s",
    duration: "60s",
    preAllocatedVUs: 25,
    maxVUs: 100,
  });
});

test("a ramp whose endpoints are equal collapses to a constant-arrival-rate executor", () => {
  const { plan } = planTimeline(singleLoad(new RampShape({ direction: "up", fromRatePerSec: 50, toRatePerSec: 50 }), 30), {
    target: TARGET,
  });

  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "constant-arrival-rate");
  assert.equal(iterationBudget(executor), 1500);
});

test("a sine is sampled into many ramping-arrival-rate stages whose area matches the analytic integral", () => {
  const shape = new SineShape({ baseRatePerSec: 200, amplitudeRatePerSec: 100, direction: "rise" });
  const { plan } = planTimeline(singleLoad(shape, 32), { target: TARGET });

  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "ramping-arrival-rate");
  assert.ok(executor.executor === "ramping-arrival-rate" && executor.stages.length === 16);

  // Integrate the authored shape itself; the sampled executor must agree within a percent.
  let analytic = 0;
  for (let t = 0; t < 32; t += 0.01) analytic += shape.rateAt(t, 32) * 0.01;
  assert.ok(Math.abs(iterationBudget(executor) - analytic) / analytic < 0.01, `sampled area ${iterationBudget(executor)} vs ${analytic}`);
});

test("a bell curve's sampled stages peak near its configured magnitude", () => {
  const { plan } = planTimeline(singleLoad(new BellShape({ peakRatePerSec: 90 }), 40), { target: TARGET });

  const executor = plan.loads[0].executor;
  assert.ok(executor.executor === "ramping-arrival-rate");
  const peak = Math.max(...executor.stages.map((stage) => stage.target)) / (executor.timeUnit === "1m" ? 60 : 1);
  assert.ok(peak > 80 && peak <= 90, `peak ${peak} should approach 90`);
});

test("a spike runs as a short constant-arrival-rate window at its magnitude", () => {
  const { plan } = planTimeline(singleLoad(new SpikeShape({ magnitudeRatePerSec: 400 }), 0, 10), { target: TARGET });

  assert.deepEqual(plan.loads[0].executor, {
    executor: "constant-arrival-rate",
    rate: 400,
    timeUnit: "1s",
    duration: `${INSTANTANEOUS_WINDOW_SECONDS}s`,
    preAllocatedVUs: 100,
    maxVUs: 400,
  });
});

test("an individual load becomes a literal shared-iterations count, not a rate", () => {
  const { plan } = planTimeline(singleLoad(new IndividualShape({ requestCount: 3 }), 0, 5), { target: TARGET });

  assert.deepEqual(plan.loads[0].executor, {
    executor: "shared-iterations",
    vus: 3,
    iterations: 3,
    maxDuration: `${INSTANTANEOUS_WINDOW_SECONDS}s`,
  });
});

// ---------------------------------------------------------------------------------------------
// Splitting a load into one script per request type (ADR 0005)
// ---------------------------------------------------------------------------------------------

test("each request type becomes its own script, at its share of the load's rate", () => {
  const timeline = timelineWith(
    track("mixed", load("l1", 0, 60, new ConstantShape({ ratePerSec: 100 }), spec("r-read", "read", "shell", 70), spec("r-create", "create", "shell", 30))),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  const scripts = planScripts(plan);

  assert.equal(scripts.length, 2);
  const byRequest = new Map(scripts.map((script) => [script.requestId, script]));
  assert.deepEqual(
    byRequest.get("r-read")?.executor,
    { executor: "constant-arrival-rate", rate: 70, timeUnit: "1s", duration: "60s", preAllocatedVUs: 18, maxVUs: 72 },
  );
  assert.equal((byRequest.get("r-create")?.executor as { rate: number }).rate, 30);
  // Both scripts belong to the same load, so results still roll up per load.
  assert.equal(new Set(scripts.map((script) => script.loadKey)).size, 1);
  assert.equal(plan.expectedRequests, 6000);
});

test("a share that is not a whole number of requests per second is expressed per minute", () => {
  const timeline = timelineWith(
    track("thirds", load("l1", 0, 60, new ConstantShape({ ratePerSec: 10 }), spec("a", "read", "shell", 1), spec("b", "read", "submodel", 1), spec("c", "query", "shell", 1))),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  const scripts = planScripts(plan);

  for (const script of scripts) {
    assert.equal((script.executor as { timeUnit: string }).timeUnit, "1m");
    assert.equal((script.executor as { rate: number }).rate, 200);
  }
  // 3 × 200/min × 60s = 600 — exactly the load's own 10 req/s × 60s.
  assert.equal(plan.expectedRequests, 600);
});

test("an individual load's literal count is split across its request types, exactly", () => {
  const timeline = timelineWith(
    track("lifecycle", load("l1", 0, 0, new IndividualShape({ requestCount: 5 }), spec("a", "create", "shell", 1), spec("b", "create", "submodel", 1))),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  const counts = planScripts(plan).map((script) => (script.executor as { iterations: number }).iterations);

  assert.deepEqual(counts.slice().sort(), [2, 3]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 5);
});

test("scripts are numbered in the order k6 starts them, across tracks", () => {
  const timeline = timelineWith(
    track("late", load("l-late", 30, 10, new ConstantShape({ ratePerSec: 5 }), spec("r2", "query", "shell", 1))),
    track("early", load("l-early", 0, 10, new ConstantShape({ ratePerSec: 5 }), spec("r1", "create", "submodel", 1))),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  const scripts = planScripts(plan);

  assert.deepEqual(scripts.map((script) => script.file), ["k6_early_l_early_r1.js", "k6_late_l_late_r2.js"]);
  assert.deepEqual(scripts.map((script) => script.key), ["s01_create_submodel", "s02_query_shell"]);
  assert.deepEqual(scripts.map((script) => script.startSeconds), [0, 30]);
});

test("operations map onto the documented IDTA-01002 endpoints", () => {
  const operations: RequestSpec["operation"][] = ["create", "read", "update", "delete", "query"];
  const timeline = timelineWith(
    track(
      "ops",
      load("l1", 0, 60, new ConstantShape({ ratePerSec: 50 }), ...operations.map((operation, index) => spec(`r${index}`, operation, "submodel", 1))),
    ),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  for (const script of planScripts(plan)) {
    const expected = describeOperation(script.operation, script.target);
    assert.equal(script.method, expected.method);
    assert.equal(script.pathTemplate, expected.pathTemplate);
    assert.deepEqual(script.expectStatus, expected.expectStatus);
  }
});

test("loads that would send nothing are dropped rather than compiled into idle scenarios", () => {
  const timeline = timelineWith(
    track("quiet", load("zero-rate", 0, 60, new ConstantShape({ ratePerSec: 0 }), spec("r1", "query", "shell", 1))),
    track("empty", load("no-requests", 0, 60, new ConstantShape({ ratePerSec: 10 }))),
    track("real", load("works", 0, 60, new ConstantShape({ ratePerSec: 10 }), spec("r2", "query", "shell", 1))),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });

  assert.deepEqual(plan.loads.map((planned) => planned.loadId), ["works"]);
});

test("an invalid timeline is rejected before any script is generated", () => {
  const broken = { totalDurationSeconds: 60, tracks: [{ id: "t", label: "T", loads: [{ id: "l", startSeconds: 0 }] }] };
  assert.throws(() => planTimeline(broken as never, { target: TARGET }), TimelineValidationError);
});

test("load keys are unique and safe to use as engine identifiers", () => {
  const awkward = "track/with spaces & symbols!";
  const timeline = timelineWith(
    new Track({
      id: awkward,
      label: "Awkward",
      loads: [
        load("load one", 0, 10, new ConstantShape({ ratePerSec: 1 }), spec("r1", "query", "shell", 1)),
        load("load two", 20, 10, new ConstantShape({ ratePerSec: 1 }), spec("r2", "query", "shell", 1)),
      ],
    }),
  );

  const { plan } = planTimeline(timeline, { target: TARGET });
  const keys = plan.loads.map((planned) => planned.key);

  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_]+$/);
});

// ---------------------------------------------------------------------------------------------
// Identifier pools: which identifiers a script addresses, and when they exist (ADR 0005)
// ---------------------------------------------------------------------------------------------

/** create at 0s → read at 20s → delete at 40s, on shells. The lifecycle the Run screen demos. */
function lifecycle(): LoadTimeline {
  return timelineWith(
    track(
      "lifecycle",
      load("create", 0, 0, new IndividualShape({ requestCount: 2 }), spec("c", "create", "shell", 1)),
      load("read", 20, 0, new IndividualShape({ requestCount: 2 }), spec("r", "read", "shell", 1)),
      load("delete", 40, 0, new IndividualShape({ requestCount: 2 }), spec("d", "delete", "shell", 1)),
    ),
  );
}

test("a read addresses exactly what an earlier create made, by identifier", async () => {
  const { plan } = await compile(lifecycle());
  const [create, read] = planScripts(plan);

  assert.equal(create.identifiers.use, "mint");
  assert.equal(read.identifiers.use, "cycle");
  // Two creates are expected, so exactly those two identifiers are addressable afterwards; the
  // create's own list carries spare headroom beyond them.
  assert.deepEqual(read.identifiers.list, create.identifiers.list.slice(0, 2));
  assert.ok(create.identifiers.list.length > 2);
  assert.equal(read.identifiers.origin, "run");
});

test("a delete claims the identifiers it removes, so nothing later addresses them", async () => {
  const timeline = timelineWith(
    track(
      "lifecycle",
      load("create", 0, 0, new IndividualShape({ requestCount: 2 }), spec("c", "create", "shell", 1)),
      load("delete", 20, 0, new IndividualShape({ requestCount: 2 }), spec("d", "delete", "shell", 1)),
      load("read-after-delete", 40, 0, new IndividualShape({ requestCount: 1 }), spec("r", "read", "shell", 1)),
    ),
  );

  const { plan, warnings } = await compile(timeline);
  const [create, remove, read] = planScripts(plan);

  assert.equal(remove.identifiers.use, "each-once");
  assert.deepEqual(remove.identifiers.list, create.identifiers.list.slice(0, 2));
  assert.deepEqual(read.identifiers.list, [], "a read after the delete has nothing left to address");
  assert.ok(warnings.some((issue) => issue.message.includes("k6_lifecycle_read_after_delete_r.js") && issue.message.includes("no shell is known to exist")));
});

test("identifiers found on the target are used when the scenario creates none", async () => {
  const timeline = timelineWith(track("reads", load("l1", 0, 60, new ConstantShape({ ratePerSec: 1 }), spec("r", "read", "submodel", 1))));

  const { plan } = await compile(timeline, targetWith({ submodel: ["urn:a", "urn:b", "urn:c"] }));

  assert.deepEqual(onlyScript(plan).identifiers.list, ["urn:a", "urn:b", "urn:c"]);
  assert.equal(plan.harvested.submodel, 3);
});

test('idPool.source "server" ignores what the run creates', async () => {
  const timeline = timelineWith(
    track(
      "mixed",
      load("create", 0, 0, new IndividualShape({ requestCount: 2 }), spec("c", "create", "shell", 1)),
      load("read", 20, 0, new IndividualShape({ requestCount: 2 }), spec("r", "read", "shell", 1, { source: "server" })),
    ),
  );

  const { plan } = await compile(timeline, targetWith({ shell: ["urn:existing-1", "urn:existing-2"] }));
  const read = planScripts(plan)[1];

  assert.deepEqual(read.identifiers.list, ["urn:existing-1", "urn:existing-2"]);
  assert.equal(read.identifiers.origin, "server");
});

test("an explicit server source whose corpus is empty only warns by default", async () => {
  const timeline = timelineWith(
    track("reads", load("l1", 0, 60, new ConstantShape({ ratePerSec: 1 }), spec("r", "read", "shell", 1, { source: "server" }))),
  );

  const { plan, warnings } = await compile(timeline, emptyTarget);

  assert.deepEqual(onlyScript(plan).identifiers.list, [], "the empty corpus is treated like any other empty pool");
  assert.ok(warnings.some((issue) => issue.message.includes("no shell identifiers on the target")));
});

test("a request's own idPool.onEmpty: \"fail\" restores the stricter, opt-in behaviour", async () => {
  const timeline = timelineWith(
    track("reads", load("l1", 0, 60, new ConstantShape({ ratePerSec: 1 }), spec("r", "read", "shell", 1, { source: "server", onEmpty: "fail" }))),
  );

  await assert.rejects(() => compile(timeline, emptyTarget), EmptyServerCorpusError);
});

test("one request's \"fail\" wins the whole compile, even if another sharing its entity said \"warn\"", async () => {
  const timeline = timelineWith(
    track(
      "reads",
      load(
        "l1",
        0,
        60,
        new ConstantShape({ ratePerSec: 1 }),
        spec("tolerant", "read", "shell", 1, { source: "server" }),
        spec("strict", "update", "shell", 1, { source: "server", onEmpty: "fail" }),
      ),
    ),
  );

  await assert.rejects(() => compile(timeline, emptyTarget), EmptyServerCorpusError);
});

test("an empty harvest is only fatal for an explicit server source", async () => {
  const timeline = timelineWith(track("reads", load("l1", 0, 60, new ConstantShape({ ratePerSec: 1 }), spec("r", "read", "shell", 1))));

  const { plan, warnings } = await compile(timeline, emptyTarget);

  assert.deepEqual(onlyScript(plan).identifiers.list, []);
  assert.ok(warnings.some((issue) => issue.message.includes("will be skipped")));
});

test("a delete with more iterations than identifiers keeps the rate and says so", async () => {
  const timeline = timelineWith(
    track("purge", load("l1", 0, 60, new ConstantShape({ ratePerSec: 100 }), spec("d", "delete", "shell", 1, { source: "server", maxIds: 100000 }))),
  );

  const { plan, warnings } = await compile(timeline, targetWith({ shell: Array.from({ length: 5 }, (_, i) => `urn:s${i}`) }));
  const script = onlyScript(plan);

  assert.equal(script.identifiers.list.length, 5, "deletes exactly what exists, each once");
  assert.equal((script.executor as { rate: number }).rate, 100, "the authored rate is not trimmed");
  assert.ok(warnings.some((issue) => issue.message.includes("nothing left to delete")));
});

test("an Exact create contributes its own identifier to what later scripts address", async () => {
  const timeline = timelineWith(
    track(
      "exact",
      load("create", 0, 0, new IndividualShape({ requestCount: 1 }), new RequestSpec({
        id: "c",
        operation: "create",
        target: "shell",
        weight: 1,
        generator: new ExactGenerator({ value: JSON.stringify({ modelType: "AssetAdministrationShell", id: "urn:fixed-1" }) }),
      })),
      load("read", 20, 0, new IndividualShape({ requestCount: 1 }), spec("r", "read", "shell", 1)),
    ),
  );

  const { plan } = await compile(timeline);
  const [create, read] = planScripts(plan);

  assert.deepEqual(create.identifiers.list, [], "an Exact body carries its own identifier");
  assert.deepEqual(read.identifiers.list, ["urn:fixed-1"]);
});

test("a shell create embeds real references to submodels created earlier", async () => {
  const timeline = timelineWith(
    track(
      "refs",
      load("make-submodels", 0, 0, new IndividualShape({ requestCount: 4 }), spec("sm", "create", "submodel", 1)),
      load(
        "make-shells",
        20,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "shell",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 256 }),
          references: { target: "submodel", count: 2 },
        }),
      ),
    ),
  );

  const { plan, files } = await compile(timeline);
  const [submodelScript, shellScript] = planScripts(plan);

  // Two shells, two submodels each, drawn from the four just minted — none repeated.
  assert.equal(shellScript.referencedIds.length, 2);
  assert.deepEqual(shellScript.referencedIds[0], submodelScript.identifiers.list.slice(0, 2));
  assert.deepEqual(shellScript.referencedIds[1], submodelScript.identifiers.list.slice(2, 4));

  const shellFile = (files.find((file) => file.name === shellScript.file) as GeneratedFile).content;
  assert.match(shellFile, /const REFERENCE_IDS = /);
  assert.match(shellFile, /submodels: REFERENCE_IDS\[i\]\.map/);
  assert.match(shellFile, /function bodyFor\(id, i\)/);
  // Only the 4 submodels actually expected to be created are ever referenced — not the spare
  // headroom ids `identifiers.list` also carries (CREATE_ID_HEADROOM in compileTimeline.ts).
  for (const id of submodelScript.identifiers.list.slice(0, 4)) {
    assert.ok(shellFile.includes(JSON.stringify(id)), `${id} missing from ${shellScript.file}`);
  }
});

test("a generator's sizeBytesPool is embedded as a pool the script draws from per request, not a fixed size", async () => {
  const timeline = timelineWith(
    track(
      "pool",
      load(
        "make-submodels",
        0,
        0,
        new IndividualShape({ requestCount: 3 }),
        new RequestSpec({
          id: "sm",
          operation: "create",
          target: "submodel",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 256, sizeBytesPool: [256, 4096, 16384] }),
        }),
      ),
    ),
  );

  const { plan, files } = await compile(timeline);
  const script = onlyScript(plan);
  const file = (files.find((f) => f.name === script.file) as GeneratedFile).content;

  assert.match(file, /const SIZE_BYTES_POOL = \[256, 4096, 16384\];/);
  assert.match(file, /function pickSizeBytes\(\)/);
  assert.match(file, /const SIZE_BYTES = pickSizeBytes\(\);/);
  assert.doesNotMatch(file, /const SIZE_BYTES = \d+;/, "no fixed size should remain once a real pool is set");
});

test("a generator with no real pool still renders through pickSizeBytes, from a one-entry pool", async () => {
  const timeline = timelineWith(
    track("single", load("make-shells", 0, 0, new IndividualShape({ requestCount: 2 }), spec("shell", "create", "shell", 1))),
  );

  const { plan, files } = await compile(timeline);
  const script = onlyScript(plan);
  const file = (files.find((f) => f.name === script.file) as GeneratedFile).content;

  assert.match(file, /const SIZE_BYTES_POOL = \[128\];/);
  assert.match(file, /const SIZE_BYTES = pickSizeBytes\(\);/);
});

test("too few submodels for the shells that reference them is a warning, not a failure", async () => {
  const timeline = timelineWith(
    track(
      "refs",
      load("make-submodels", 0, 0, new IndividualShape({ requestCount: 1 }), spec("sm", "create", "submodel", 1)),
      load(
        "make-shells",
        20,
        0,
        new IndividualShape({ requestCount: 1 }),
        new RequestSpec({
          id: "shell",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 256 }),
          references: { target: "submodel", count: 3 },
        }),
      ),
    ),
  );

  const { plan, warnings } = await compile(timeline);
  const [, shellScript] = planScripts(plan);

  assert.deepEqual(shellScript.referencedIds, [shellScript.referencedIds[0]], "one group, short of the requested 3");
  assert.ok(shellScript.referencedIds[0].length < 3);
  assert.ok(warnings.some((issue) => issue.message.includes("will reference fewer than 3")));
});

test("a create with mintId follows its own format, one counter per entity across the whole scenario", async () => {
  const timeline = timelineWith(
    track(
      "mint",
      load(
        "shells-1",
        0,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "shell-a",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 128 }),
          mintId: { format: "urn:kaigara:aas:<Num>" },
        }),
      ),
      // A second, unrelated create of the same entity — the counter must not reset for it.
      load(
        "shells-2",
        20,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "shell-b",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 128 }),
          mintId: { format: "urn:kaigara:aas:<Num>" },
        }),
      ),
    ),
  );

  const { plan, files } = await compile(timeline);
  const [first, second] = planScripts(plan);

  // Each script mints CREATE_ID_HEADROOM (2) spares beyond its own 2 expected, so the counter
  // advances by 4 before the second script starts — proof it is one shared counter, not "restart
  // per script": if it reset, the second script would start at 0, not 4.
  assert.deepEqual(first.identifiers.list.slice(0, 2), ["urn:kaigara:aas:0", "urn:kaigara:aas:1"]);
  assert.deepEqual(second.identifiers.list.slice(0, 2), ["urn:kaigara:aas:4", "urn:kaigara:aas:5"]);

  const firstFile = (files.find((file) => file.name === first.file) as GeneratedFile).content;
  assert.match(firstFile, /"urn:kaigara:aas:0"/);
});

test("a mint id without <Num> replaced is not fatal — the format is still used, just unhelpfully", async () => {
  // The validator warns about this (loadTimelineValidation.test.ts); the engine's own job is only
  // to not crash on a document that slipped past it (e.g. posted straight to the API).
  const timeline = timelineWith(
    track(
      "mint",
      load(
        "shells",
        0,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "shell",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 128 }),
          mintId: { format: "urn:kaigara:aas:fixed" },
        }),
      ),
    ),
  );

  const { plan } = await compile(timeline);
  assert.deepEqual(onlyScript(plan).identifiers.list.slice(0, 2), ["urn:kaigara:aas:fixed", "urn:kaigara:aas:fixed"]);
});

test("a create with no mintId at all warns rather than silently minting Kaigara's own scheme", async () => {
  const timeline = timelineWith(
    track("mint", load("shells", 0, 0, new IndividualShape({ requestCount: 2 }), spec("shell", "create", "shell", 1))),
  );

  const { plan, warnings } = await compile(timeline);
  assert.match(onlyScript(plan).identifiers.list[0], /^https:\/\/kaigara\.dev\/ids\/shell\//);
  assert.ok(warnings.some((issue) => issue.message.includes("no mintId.format configured") && issue.message.includes("https://kaigara.dev/ids/shell")));
});

test("a create with an idPool duplicates an existing identifier instead of minting", async () => {
  const timeline = timelineWith(
    track(
      "dup",
      load("make-shells", 0, 0, new IndividualShape({ requestCount: 3 }), spec("original", "create", "shell", 1)),
      load(
        "duplicate-shells",
        20,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "dup",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 128 }),
          idPool: { source: "created" },
        }),
      ),
    ),
  );

  const { plan, files } = await compile(timeline);
  const [original, duplicate] = planScripts(plan);

  assert.equal(duplicate.identifiers.use, "cycle", "an existing id is cycled, not minted");
  assert.ok(duplicate.identifiers.list.length > 0);
  // Every id the duplicate script addresses is one the first script actually minted — nothing new.
  for (const id of duplicate.identifiers.list) assert.ok(original.identifiers.list.includes(id), `${id} was not minted by ${original.file}`);

  const duplicateFile = (files.find((file) => file.name === duplicate.file) as GeneratedFile).content;
  assert.match(duplicateFile, /const IDS = /);
  assert.match(duplicateFile, /IDS\[i % IDS\.length\]/);
});

test("a create's idPool falls back to the server when this run creates nothing to duplicate", async () => {
  const timeline = timelineWith(
    track(
      "dup",
      load(
        "duplicate-shells",
        0,
        0,
        new IndividualShape({ requestCount: 2 }),
        new RequestSpec({
          id: "dup",
          operation: "create",
          target: "shell",
          weight: 1,
          generator: new RandomizedGenerator({ sizeBytes: 128 }),
          idPool: { source: "server" },
        }),
      ),
    ),
  );

  const { plan } = await compile(timeline, targetWith({ shell: ["urn:existing-1", "urn:existing-2"] }));
  assert.deepEqual(onlyScript(plan).identifiers.list, ["urn:existing-1", "urn:existing-2"]);
});

test("the harvest is paged by cursor and capped by the largest request that asked", async () => {
  const pages: Record<string, { result: { id: string }[]; paging_metadata: { cursor?: string } }> = {
    "1": { result: [{ id: "urn:1" }, { id: "urn:2" }], paging_metadata: { cursor: "page2" } },
    "2": { result: [{ id: "urn:3" }], paging_metadata: {} },
  };
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    return new Response(JSON.stringify(url.includes("cursor=page2") ? pages["2"] : pages["1"]), { status: 200 });
  }) as typeof fetch;

  try {
    const ids = await httpHarvester(TARGET)("shell", 250);
    assert.deepEqual(ids, ["urn:1", "urn:2", "urn:3"]);
    assert.ok(seen[0].includes("/shells?limit=100"), seen[0]);
    assert.ok(seen[1].includes("cursor=page2"), seen[1]);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------------------------
// The generated files
// ---------------------------------------------------------------------------------------------

const exec = promisify(execFile);

/** Writes the generated files out and has Node parse each as an ES module — the cheapest proof
 *  that what k6 will be handed is syntactically valid JavaScript. */
async function assertParses(files: GeneratedFile[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kaigara-scripts-"));
  try {
    for (const file of files) {
      const name = file.name.replace(/\.js$/, ".mjs");
      await writeFile(join(dir, name), file.content.replace(/from "\.\/([^"]+)\.js"/g, 'from "./$1.mjs"'), "utf8");
    }
    for (const file of files) await exec(process.execPath, ["--check", join(dir, file.name.replace(/\.js$/, ".mjs"))]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A timeline exercising every operation and every generator kind. */
function everything(): LoadTimeline {
  return timelineWith(
    track(
      "mixed",
      load(
        "l-ramp",
        0,
        20,
        new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 100 }),
        spec("r1", "query", "shell", 1),
        spec("r2", "create", "shell", 1),
      ),
      load(
        "l-const",
        30,
        60,
        new ConstantShape({ ratePerSec: 20 }),
        spec("r3", "update", "submodel", 1),
        spec("r4", "delete", "submodel", 1),
        new RequestSpec({
          id: "r5",
          operation: "create",
          target: "submodel",
          weight: 1,
          generator: new ExactGenerator({ value: '{"modelType":"Submodel","id":"urn:exact"}' }),
        }),
        new RequestSpec({
          id: "r6",
          operation: "update",
          target: "shell",
          weight: 1,
          generator: new MutateGenerator({ baseValue: '{"modelType":"AssetAdministrationShell","id":"urn:base"}', mutationRatePercent: 25 }),
        }),
      ),
      load("l-individual", 100, 0, new IndividualShape({ requestCount: 2 }), spec("r7", "create", "shell", 1)),
    ),
  );
}

test("every generated file is syntactically valid JavaScript", async () => {
  const { files } = await compile(everything(), targetWith({ shell: ["urn:s1"], submodel: ["urn:m1", "urn:m2"] }));
  await assertParses(files);
});

/** The capture functions a generated script defines, evaluated on their own. */
function captureFunctions(content: string): {
  keepComplete: (i: number, status: number) => boolean;
  captured: (body: unknown, complete: boolean) => { text: string; truncated: boolean; bytes: number };
} {
  const start = content.indexOf("// Capture:");
  const end = content.indexOf("export function run()");
  assert.ok(start !== -1 && end > start, "expected the capture block before run()");
  return new Script(`${content.slice(start, end)}\n({ keepComplete, captured })`).runInNewContext({});
}

test("every capture mode renders a keepComplete that keeps what the mode promises, and still parses", async () => {
  // 50 req/s for 60 s: ~3000 successes, so sampling keeps 1 in 30.
  const base = singleLoad(new ConstantShape({ ratePerSec: 50 }), 60);
  const modes = [
    { capture: undefined, ok: [false, false], error: false },
    { capture: { mode: "capped", storeAllErrors: true }, ok: [false, false], error: true },
    { capture: { mode: "complete" }, ok: [true, true], error: true },
    { capture: { mode: "capped-sampled" }, ok: [true, false], error: true },
    { capture: { mode: "capped-sampled", storeAllErrors: true }, ok: [true, false], error: true },
  ] as const;

  for (const { capture, ok, error } of modes) {
    const { files } = await compile(base.with({ capture }));
    await assertParses(files);
    const { keepComplete } = captureFunctions(files[1].content);
    const label = JSON.stringify(capture ?? "default");
    assert.deepEqual([keepComplete(0, 200), keepComplete(1, 200)], ok, `${label}: successes`);
    assert.equal(keepComplete(1, 500), error, `${label}: an error`);
  }
});

test("sampled capture puts errors first, from a per-VU budget that runs out unless every error is kept", async () => {
  const base = singleLoad(new ConstantShape({ ratePerSec: 50 }), 60);
  const budgeted = captureFunctions((await compile(base.with({ capture: { mode: "capped-sampled" } }))).files[1].content);
  const kept = Array.from({ length: 50 }, (_, i) => budgeted.keepComplete(i, 404)).filter(Boolean).length;
  assert.ok(kept >= 10 && kept < 50, `a burst of errors is kept up to the budget, not all of them (kept ${kept})`);

  const all = captureFunctions(
    (await compile(base.with({ capture: { mode: "capped-sampled", storeAllErrors: true } }))).files[1].content,
  );
  assert.ok(Array.from({ length: 50 }, (_, i) => all.keepComplete(i, 404)).every(Boolean));
});

test("a captured body is cut at the cap only when not kept complete, and reports its real UTF-8 size", async () => {
  const { captured } = captureFunctions((await compile(singleLoad(new ConstantShape({ ratePerSec: 1 }), 10))).files[1].content);
  const long = "a".repeat(64 * 1024 + 10);

  // Spread: objects made inside the vm context have that context's Object prototype.
  assert.deepEqual({ ...captured(long, false) }, { text: long.slice(0, 64 * 1024), truncated: true, bytes: long.length });
  assert.deepEqual({ ...captured(long, true) }, { text: long, truncated: false, bytes: long.length });
  assert.equal(captured("ü€😀", false).bytes, 2 + 3 + 4);
  assert.deepEqual({ ...captured(null, false) }, { text: "", truncated: false, bytes: 0 });
});

test("main.js schedules one k6 scenario per script and exports every exec it names", async () => {
  const { plan, files } = await compile(everything(), targetWith({ shell: ["urn:s1"], submodel: ["urn:m1"] }));
  const main = files[0];

  assert.equal(main.name, "main.js");
  const scripts = planScripts(plan);
  assert.equal(files.length, scripts.length + 1);

  for (const script of scripts) {
    assert.match(main.content, new RegExp(`import \\* as \\w+ from "\\./${script.file.replace(".", "\\.")}";`));
    assert.match(main.content, new RegExp(`export const ${script.key} = \\w+\\.run;`));
    assert.match(main.content, new RegExp(`${script.key}: \\{ \\.\\.\\.\\w+\\.EXECUTOR, startTime: "\\d+s", exec: "${script.key}" \\}`));
  }
  // Every exec named in options must be exported from this module, or k6 refuses to start.
  for (const [, name] of main.content.matchAll(/exec: "([^"]+)"/g)) {
    assert.match(main.content, new RegExp(`export const ${name} = `), `missing export for exec "${name}"`);
  }
});

test("a script runs standalone: its own options, executor and generator", async () => {
  const { files } = await compile(lifecycle());
  const read = files.find((file) => file.name === "k6_lifecycle_read_r.js") as GeneratedFile;

  assert.match(read.content, /export const EXECUTOR = /);
  assert.match(read.content, /export const options = \{ scenarios: \{ s02_read_shell: EXECUTOR \} \}/);
  assert.match(read.content, /function requestFor\(i\) \{/);
  assert.match(read.content, /export default run;/);
  assert.match(read.content, /const id = IDS\[i % IDS\.length\];/);
});

test("a create script walks its identifiers once each, a delete script too, and a read cycles", async () => {
  const { files } = await compile(lifecycle());
  const source = (name: string) => (files.find((file) => file.name === name) as GeneratedFile).content;

  assert.match(source("k6_lifecycle_create_c.js"), /if \(i >= IDS\.length\) return null;\n {2}const id = IDS\[i\];/);
  assert.match(source("k6_lifecycle_delete_d.js"), /if \(i >= IDS\.length\) return null;\n {2}const id = IDS\[i\];/);
  assert.match(source("k6_lifecycle_read_r.js"), /if \(IDS\.length === 0\) return null;/);
});

test("the scripts embed their identifiers and discover nothing at run time", async () => {
  const { files } = await compile(lifecycle());
  const create = (files.find((file) => file.name === "k6_lifecycle_create_c.js") as GeneratedFile).content;
  const read = (files.find((file) => file.name === "k6_lifecycle_read_r.js") as GeneratedFile).content;

  assert.match(create, /const IDS = \[\n {2}"https:\/\/kaigara\.dev\/ids\/shell\/nonce-0",/);
  assert.ok(read.includes('"https://kaigara.dev/ids/shell/nonce-0"'));
  // No script may page the server for identifiers: that is the compile's job (ADR 0003).
  for (const file of files) {
    assert.ok(!/\/shells\?limit=\d+.*cursor/.test(file.content), `${file.name} appears to harvest identifiers`);
    assert.ok(!file.content.includes("setup()"), `${file.name} must not use a k6 setup()`);
  }
});

test("target headers never reach a generated file — they come from the environment", async () => {
  const secret = "Bearer super-secret-token";
  const { plan, files } = await compileTimeline(lifecycle(), {
    target: { ...TARGET, headers: { authorization: secret } },
    scenarioName: "secrets",
    harvest: emptyTarget,
    nonce: "nonce",
  });

  for (const file of files) {
    assert.ok(!file.content.includes(secret), `${file.name} leaks the target's Authorization header`);
    assert.ok(!file.content.includes("super-secret"), `${file.name} leaks a credential`);
  }
  assert.ok(files[1].content.includes(`__ENV.${HEADERS_ENV}`));
  // The in-memory plan keeps the real headers (the adapter hands them to k6); only what is written
  // out or returned is redacted — see redactPlan, exercised by the adapter and RunService.
  assert.equal(plan.target.headers.authorization, secret);
});

test("a query script addresses no identifier and needs no skip counter", async () => {
  const timeline = timelineWith(track("t", load("l", 0, 10, new ConstantShape({ ratePerSec: 5 }), spec("q", "query", "shell", 1))));
  const { files } = await compile(timeline);
  const query = files[1].content;

  assert.ok(!query.includes("const IDS"));
  assert.ok(!query.includes("kaigara_skipped_no_id"));
  assert.match(query, /\$\{BASE_URL\}\/shells\?limit=20/);
});

test("a large identifier list is held in a SharedArray rather than copied per VU", async () => {
  const corpus = Array.from({ length: 1500 }, (_, i) => `urn:many-${i}`);
  const timeline = timelineWith(
    track("reads", load("l1", 0, 600, new ConstantShape({ ratePerSec: 50 }), spec("r", "read", "shell", 1, { source: "server", maxIds: 5000 }))),
  );

  const { files } = await compile(timeline, targetWith({ shell: corpus }));

  assert.match(files[1].content, /import \{ SharedArray \} from "k6\/data";/);
  assert.match(files[1].content, /const IDS = new SharedArray\("s01_read_shell", \(\) => \[/);
});
