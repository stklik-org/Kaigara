import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

const TARGET = { baseUrl: "http://127.0.0.1:8081/api/v3", timeoutSeconds: 30, headers: {} };

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
  const shape = new SineShape({ peakRatePerSec: 200 });
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

  assert.deepEqual(scripts.map((script) => script.file), ["01-create-submodel.js", "02-query-shell.js"]);
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
  assert.ok(warnings.some((issue) => issue.message.includes("03-read-shell.js") && issue.message.includes("no shell is known to exist")));
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

test("an explicit server source whose corpus is empty fails the compile", async () => {
  const timeline = timelineWith(
    track("reads", load("l1", 0, 60, new ConstantShape({ ratePerSec: 1 }), spec("r", "read", "shell", 1, { source: "server" }))),
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
  const read = files.find((file) => file.name === "02-read-shell.js") as GeneratedFile;

  assert.match(read.content, /export const EXECUTOR = /);
  assert.match(read.content, /export const options = \{ scenarios: \{ s02_read_shell: EXECUTOR \} \}/);
  assert.match(read.content, /function requestFor\(i\) \{/);
  assert.match(read.content, /export default run;/);
  assert.match(read.content, /const id = IDS\[i % IDS\.length\];/);
});

test("a create script walks its identifiers once each, a delete script too, and a read cycles", async () => {
  const { files } = await compile(lifecycle());
  const source = (name: string) => (files.find((file) => file.name === name) as GeneratedFile).content;

  assert.match(source("01-create-shell.js"), /if \(i >= IDS\.length\) return null;\n {2}const id = IDS\[i\];/);
  assert.match(source("03-delete-shell.js"), /if \(i >= IDS\.length\) return null;\n {2}const id = IDS\[i\];/);
  assert.match(source("02-read-shell.js"), /if \(IDS\.length === 0\) return null;/);
});

test("the scripts embed their identifiers and discover nothing at run time", async () => {
  const { files } = await compile(lifecycle());
  const create = (files.find((file) => file.name === "01-create-shell.js") as GeneratedFile).content;
  const read = (files.find((file) => file.name === "02-read-shell.js") as GeneratedFile).content;

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
