import test from "node:test";
import assert from "node:assert/strict";

import {
  BellShape,
  ConstantShape,
  ExactGenerator,
  IndividualShape,
  Load,
  LoadTimeline,
  RampShape,
  RandomizedGenerator,
  RequestComposition,
  RequestSpec,
  SineShape,
  SpikeShape,
  Track,
  TimelineValidationError,
  INSTANTANEOUS_WINDOW_SECONDS,
} from "@kaigara/shared-types";

import { compileTimeline } from "../src/engines/k6/compileTimeline.ts";
import { compileK6Script } from "../src/engines/k6/compileScript.ts";
import { EmptyServerCorpusError, resolveIdentifiers } from "../src/engines/k6/resolveIdentifiers.ts";
import { describeOperation } from "../src/timeline/aasOperations.ts";

const TARGET = { baseUrl: "http://127.0.0.1:8081/api/v3", timeoutSeconds: 30, headers: {} };

/** Stubs `global.fetch` for the duration of a test, so `resolveIdentifiers`'s compile-time harvest
 *  never makes a real network call. `handler` sees the requested URL and returns a status/body, or
 *  `null` for "should not have been called". Always restore, even on failure. */
function mockFetch(handler: (url: string) => { status: number; body: unknown } | null): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const result = handler(url);
    if (!result) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** The empty-harvest response every test that does not care about server-sourced ids can hand
 *  `mockFetch`, so `resolveIdentifiers` completes without a real request or a thrown abort. */
function emptyHarvest(): { status: number; body: unknown } {
  return { status: 200, body: { result: [], paging_metadata: {} } };
}

function spec(
  id: string,
  operation: RequestSpec["operation"],
  target: RequestSpec["target"],
  weight: number,
): RequestSpec {
  return new RequestSpec({ id, operation, target, weight, generator: new RandomizedGenerator({ sizeBytes: 128 }) });
}

function timelineWith(...tracks: Track[]): LoadTimeline {
  return new LoadTimeline({ totalDurationSeconds: 600, tracks });
}

function singleLoad(shape: ConstructorParameters<typeof Load>[0]["shape"], durationSeconds: number, startSeconds = 0): LoadTimeline {
  return timelineWith(
    new Track({
      id: "t1",
      label: "Track 1",
      loads: [
        new Load({
          id: "l1",
          startSeconds,
          durationSeconds,
          shape,
          requests: new RequestComposition([spec("r1", "query", "shell", 1)]),
        }),
      ],
    }),
  );
}

test("a ramp maps directly to a one-stage ramping-arrival-rate executor", () => {
  const { plan } = compileTimeline(singleLoad(new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 380 }), 20), {
    target: TARGET,
  });

  assert.equal(plan.loads.length, 1);
  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "ramping-arrival-rate");
  if (executor.executor !== "ramping-arrival-rate") return;

  assert.equal(executor.startRate, 0);
  assert.deepEqual(executor.stages, [{ target: 380, duration: "20s" }]);
  assert.ok(executor.preAllocatedVUs >= 1 && executor.maxVUs >= executor.preAllocatedVUs);

  // Area under a 0→380 ramp over 20s.
  assert.equal(plan.loads[0].expectedRequests, 3800);
  assert.equal(plan.expectedRequests, 3800);
});

test("a constant load maps directly to a single constant-arrival-rate executor", () => {
  const { plan } = compileTimeline(singleLoad(new ConstantShape({ ratePerSec: 100 }), 600), { target: TARGET });
  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "constant-arrival-rate");
  if (executor.executor !== "constant-arrival-rate") return;

  assert.equal(executor.rate, 100);
  assert.equal(executor.duration, "600s");
  assert.equal(plan.expectedRequests, 60_000);
});

test("a ramp whose endpoints are equal collapses to a constant-arrival-rate executor", () => {
  const { plan } = compileTimeline(singleLoad(new RampShape({ direction: "up", fromRatePerSec: 50, toRatePerSec: 50 }), 30), {
    target: TARGET,
  });
  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "constant-arrival-rate");
  if (executor.executor !== "constant-arrival-rate") return;

  assert.equal(executor.rate, 50);
  assert.equal(executor.duration, "30s");
  assert.equal(plan.expectedRequests, 1500);
});

test("a sine is sampled into many ramping-arrival-rate stages whose area matches the analytic integral", () => {
  const durationSeconds = 40;
  const peak = 300;
  const { plan } = compileTimeline(singleLoad(new SineShape({ peakRatePerSec: peak }), durationSeconds), { target: TARGET });

  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "ramping-arrival-rate");
  if (executor.executor !== "ramping-arrival-rate") return;

  assert.ok(executor.stages.length > 1, "a curve must not collapse to one stage");
  const sampledPeak = Math.max(executor.startRate, ...executor.stages.map((stage) => stage.target));
  assert.ok(Math.abs(sampledPeak - peak) <= 2, `sampled peak ${sampledPeak} should approach ${peak}`);

  // Integral of peak*sin(pi*t/D) over [0,D] is 2*peak*D/pi.
  const analytic = (2 * peak * durationSeconds) / Math.PI;
  const relativeError = Math.abs(plan.expectedRequests - analytic) / analytic;
  assert.ok(relativeError < 0.01, `piecewise-linear error ${relativeError} should be under 1%`);
});

test("a bell curve's sampled stages peak near its configured magnitude", () => {
  const { plan } = compileTimeline(singleLoad(new BellShape({ peakRatePerSec: 400 }), 84), { target: TARGET });
  const executor = plan.loads[0].executor;
  assert.equal(executor.executor, "ramping-arrival-rate");
  if (executor.executor !== "ramping-arrival-rate") return;
  const sampledPeak = Math.max(executor.startRate, ...executor.stages.map((stage) => stage.target));
  assert.ok(sampledPeak > 390, `peak ${sampledPeak} should approach 400`);
});

test("a spike runs as a short constant-arrival-rate window at its magnitude", () => {
  const { plan } = compileTimeline(singleLoad(new SpikeShape({ magnitudeRatePerSec: 250 }), 0, 90), { target: TARGET });
  const load = plan.loads[0];
  assert.equal(load.executor.executor, "constant-arrival-rate");
  if (load.executor.executor !== "constant-arrival-rate") return;

  assert.equal(load.executor.rate, 250);
  assert.equal(load.executor.duration, `${INSTANTANEOUS_WINDOW_SECONDS}s`);
  assert.equal(load.startSeconds, 90);
  assert.equal(plan.expectedRequests, 250 * INSTANTANEOUS_WINDOW_SECONDS);
});

test("an individual load becomes a literal shared-iterations count, not a rate", () => {
  const { plan } = compileTimeline(singleLoad(new IndividualShape({ requestCount: 3 }), 0, 250), { target: TARGET });
  const executor = plan.loads[0].executor;

  assert.equal(executor.executor, "shared-iterations");
  if (executor.executor !== "shared-iterations") return;
  assert.equal(executor.iterations, 3);
  assert.equal(plan.expectedRequests, 3);
});

test("weights become a cumulative distribution ending exactly at 1", () => {
  const timeline = timelineWith(
    new Track({
      id: "t1",
      label: "CRUD",
      loads: [
        new Load({
          id: "l1",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 10 }),
          requests: new RequestComposition([
            spec("r1", "query", "shell", 85),
            spec("r2", "create", "shell", 5),
            spec("r3", "update", "shell", 8),
            spec("r4", "delete", "shell", 2),
          ]),
        }),
      ],
    }),
  );

  const { plan } = compileTimeline(timeline, { target: TARGET });
  const requests = plan.loads[0].requests;

  assert.equal(requests.length, 4);
  assert.equal(requests[0].cumulativeWeight, 0.85);
  assert.equal(requests[1].cumulativeWeight, 0.9);
  assert.equal(requests[2].cumulativeWeight, 0.98);
  // Pinned to exactly 1 so a random draw can never fall past the last bucket.
  assert.equal(requests[3].cumulativeWeight, 1);

  // Monotonically non-decreasing, which is what makes the linear scan in the script correct.
  for (let i = 1; i < requests.length; i++) {
    assert.ok(requests[i].cumulativeWeight >= requests[i - 1].cumulativeWeight);
  }
});

test("operations map onto the documented IDTA-01002 endpoints", () => {
  const query = describeOperation("query", "shell");
  assert.equal(query.method, "GET");
  assert.equal(query.pathTemplate, "/shells");
  assert.equal(query.idSource, "none");
  assert.equal(query.sendsBody, false, "a collection read must not send a body");
  assert.deepEqual(query.expectStatus, [200]);
  assert.ok(Number(query.query.limit) > 0, "a collection read must be paged");

  assert.equal(describeOperation("create", "submodel").method, "POST");
  assert.equal(describeOperation("create", "submodel").pathTemplate, "/submodels");
  assert.equal(describeOperation("create", "submodel").expectStatus[0], 201);

  const update = describeOperation("update", "submodel");
  assert.equal(update.method, "PUT");
  assert.equal(update.pathTemplate, "/submodels/{id}");
  assert.equal(update.idSource, "pool");
  assert.equal(update.consumesId, false);

  const remove = describeOperation("delete", "shell");
  assert.equal(remove.method, "DELETE");
  assert.equal(remove.idSource, "pool");
  assert.equal(remove.consumesId, true, "a delete must retire the identifier it used");

  // `read` and `query` are both GETs and are easy to conflate; they measure different things, so
  // the by-identifier one must take an id from the pool and must not page a collection.
  const read = describeOperation("read", "submodel");
  assert.equal(read.method, "GET");
  assert.equal(read.pathTemplate, "/submodels/{id}");
  assert.equal(read.idSource, "pool");
  assert.equal(read.consumesId, false, "reading must not retire the identifier it used");
  assert.equal(read.sendsBody, false);
  assert.deepEqual(read.expectStatus, [200]);
  assert.deepEqual(read.query, {}, "a by-identifier read is not paged");
});

test("loads that would send nothing are dropped rather than compiled into idle scenarios", () => {
  const timeline = timelineWith(
    new Track({
      id: "t1",
      label: "Empty",
      loads: [
        new Load({
          id: "l-empty",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 100 }),
          requests: RequestComposition.empty(),
        }),
        new Load({
          id: "l-real",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 10 }),
          requests: new RequestComposition([spec("r1", "query", "shell", 1)]),
        }),
      ],
    }),
  );

  const { plan, warnings } = compileTimeline(timeline, { target: TARGET });

  assert.equal(plan.loads.length, 1);
  assert.equal(plan.loads[0].loadId, "l-real");
  assert.ok(warnings.some((w) => /no requests/.test(w.message)), "the user should be told why it vanished");
});

test("an invalid timeline is rejected before any script is generated", () => {
  const broken = { totalDurationSeconds: 600, tracks: [{ id: "t", label: "T", loads: [{ id: "l" }] }] };
  assert.throws(() => compileTimeline(broken as never, { target: TARGET }), TimelineValidationError);
});

test("load keys are unique and safe to use as engine identifiers", () => {
  const timeline = timelineWith(
    new Track({
      id: "track with spaces/slashes",
      label: "Odd",
      loads: [
        new Load({
          id: "load#1",
          startSeconds: 0,
          durationSeconds: 10,
          shape: new ConstantShape({ ratePerSec: 5 }),
          requests: new RequestComposition([spec("r1", "query", "shell", 1)]),
        }),
        new Load({
          id: "load#2",
          startSeconds: 10,
          durationSeconds: 10,
          shape: new ConstantShape({ ratePerSec: 5 }),
          requests: new RequestComposition([spec("r2", "query", "shell", 1)]),
        }),
      ],
    }),
  );

  const { plan } = compileTimeline(timeline, { target: TARGET });
  const keys = plan.loads.map((load) => load.key);

  assert.equal(new Set(keys).size, keys.length, "keys must be unique");
  for (const key of keys) {
    assert.match(key, /^[A-Za-z0-9_]+$/, `"${key}" must be a valid JS identifier fragment`);
  }
});

test("the generated k6 script is syntactically valid JavaScript", async () => {
  const timeline = timelineWith(
    new Track({
      id: "mixed",
      label: "Mixed",
      loads: [
        new Load({
          id: "l-ramp",
          startSeconds: 0,
          durationSeconds: 20,
          shape: new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 100 }),
          requests: new RequestComposition([spec("r1", "query", "shell", 1), spec("r2", "create", "shell", 1)]),
        }),
        new Load({
          id: "l-const",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 20 }),
          requests: new RequestComposition([
            spec("r3", "update", "submodel", 1),
            spec("r4", "delete", "submodel", 1),
            new RequestSpec({
              id: "r5",
              operation: "create",
              target: "submodel",
              weight: 1,
              generator: new ExactGenerator({ value: '{"modelType":"Submodel","id":"fixed"}' }),
            }),
          ]),
        }),
        new Load({
          id: "l-individual",
          startSeconds: 30,
          durationSeconds: 0,
          shape: new IndividualShape({ requestCount: 2 }),
          requests: new RequestComposition([spec("r6", "create", "shell", 1)]),
        }),
      ],
    }),
  );

  const { plan } = compileTimeline(timeline, { target: TARGET, scenarioName: "syntax-check" });

  const restore = mockFetch(() => emptyHarvest());
  let script: string;
  try {
    const resolvedIds = await resolveIdentifiers(plan);
    script = compileK6Script(plan, resolvedIds, { summaryPath: "/tmp/summary.json" });
  } finally {
    restore();
  }

  // k6 scripts are ES modules importing "k6/http", which Node cannot resolve. Strip those imports,
  // substitute inert stand-ins, and evaluate the rest: that proves the generated file parses and
  // its module top level runs, which would otherwise only be discovered when k6 itself runs it.
  const withoutImports = script.replace(/^import .*$/gm, "");
  await assert.doesNotReject(
    async () =>
      await import(`data:text/javascript;base64,${Buffer.from(stubK6Imports(withoutImports)).toString("base64")}`),
    "generated script must parse and evaluate its module top level",
  );

  // Each scenario's `exec` must name a function the script actually exports.
  const scenarioExecs = [...script.matchAll(/"exec":\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scenarioExecs.length >= 3);
  for (const name of scenarioExecs) {
    assert.match(script, new RegExp(`export function ${name}\\(`), `missing exported exec "${name}"`);
  }
});

/** Replaces the k6 runtime the generated script imports with inert stand-ins, so the module can be
 *  evaluated in Node purely to prove it parses and its top level runs. */
function stubK6Imports(source: string): string {
  return `
const http = {
  expectedStatuses: () => ({}),
  get: () => ({ status: 200, json: () => ({ result: [] }) }),
  request: () => ({ status: 200 }),
};
const check = () => true;
const encoding = { b64encode: (v) => v };
class Counter { add() {} }
${source}
`;
}

// ---------------------------------------------------------------------------------------------
// Identifier source: "created" (the default) versus "server", where every id is paged off the
// target before the load starts.
// ---------------------------------------------------------------------------------------------

function serverSourced(id: string, operation: RequestSpec["operation"], target: RequestSpec["target"], idPool = {}): RequestSpec {
  return new RequestSpec({
    id,
    operation,
    target,
    weight: 1,
    generator: new RandomizedGenerator({ sizeBytes: 128 }),
    idPool: { source: "server", ...idPool },
  });
}

function loadWith(...requests: RequestSpec[]): LoadTimeline {
  return timelineWith(
    new Track({
      id: "t1",
      label: "Track 1",
      loads: [
        new Load({
          id: "l1",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 10 }),
          requests: new RequestComposition(requests),
        }),
      ],
    }),
  );
}

test("an id pool sourced from the server marks the request and plans a harvest", () => {
  const { plan } = compileTimeline(loadWith(serverSourced("r1", "read", "submodel", { maxIds: 5000 })), { target: TARGET });

  assert.equal(plan.loads[0].requests[0].idSource, "server");
  assert.deepEqual(plan.idHarvest, { maxIds: 5000 });
});

test("without a server-sourced request there is no harvest to plan", () => {
  const { plan } = compileTimeline(loadWith(spec("r1", "read", "submodel", 1)), { target: TARGET });

  assert.equal(plan.loads[0].requests[0].idSource, "pool");
  assert.equal(plan.idHarvest, undefined);
});

test("harvest settings are reconciled across the requests that asked for them", () => {
  // One harvest serves the whole run, so it must be big enough for the greediest request.
  const { plan } = compileTimeline(
    loadWith(
      serverSourced("r1", "read", "submodel", { maxIds: 200 }),
      serverSourced("r2", "delete", "submodel", { maxIds: 4000 }),
    ),
    { target: TARGET },
  );

  assert.deepEqual(plan.idHarvest, { maxIds: 4000 });
});

test("an id pool on an operation that addresses no identifier is inert, not an error", () => {
  // `create` mints its own id, so the descriptor says `none` and the setting cannot apply. The
  // metamodel validator warns; the compiler must not promote it to a server draw regardless.
  const { plan } = compileTimeline(loadWith(serverSourced("r1", "create", "submodel")), { target: TARGET });

  assert.equal(plan.loads[0].requests[0].idSource, "none");
  assert.equal(plan.idHarvest, undefined);
});

// ---------------------------------------------------------------------------------------------
// Identifier resolution — the compile-time harvest and create-id pre-generation that replaced the
// old k6 setup()'s own HTTP calls (see resolveIdentifiers.ts). The generated script now issues no
// request beyond the ones the timeline authored: it only ever reads the literal arrays these
// produce.
// ---------------------------------------------------------------------------------------------

test("resolveIdentifiers pages the harvest by cursor rather than stopping at one page", async () => {
  const { plan } = compileTimeline(loadWith(serverSourced("r1", "read", "submodel", { maxIds: 250 })), { target: TARGET });

  const pages = [
    { result: Array.from({ length: 100 }, (_, i) => ({ id: `urn:sm:${i}` })), paging_metadata: { cursor: "page2" } },
    { result: Array.from({ length: 60 }, (_, i) => ({ id: `urn:sm:${100 + i}` })), paging_metadata: {} },
  ];
  let calls = 0;
  const restore = mockFetch((url) => {
    assert.match(url, /\/submodels\?limit=/, "must page the submodel collection, not something else");
    const page = pages[calls] ?? { result: [], paging_metadata: {} };
    calls += 1;
    return { status: 200, body: page };
  });

  try {
    const resolved = await resolveIdentifiers(plan);
    assert.equal(resolved.server.submodel.length, 160);
    assert.equal(calls, 2, "must follow paging_metadata.cursor rather than stopping at the first page");
  } finally {
    restore();
  }
});

test("resolveIdentifiers refuses to compile a plan whose explicit server corpus is empty", async () => {
  const { plan } = compileTimeline(loadWith(serverSourced("r1", "read", "submodel", { maxIds: 2500 })), { target: TARGET });

  const restore = mockFetch(() => emptyHarvest());
  try {
    await assert.rejects(() => resolveIdentifiers(plan), EmptyServerCorpusError);
  } finally {
    restore();
  }
});

test("an empty harvest for a plain pool request is not fatal, only an explicit server source is", async () => {
  // `spec(...)` below has no idPool at all, i.e. the default "pool" source — reads/updates/deletes
  // that merely prefer a server identifier if one exists, rather than requiring one.
  const { plan } = compileTimeline(loadWith(spec("r1", "read", "submodel", 1)), { target: TARGET });

  const restore = mockFetch(() => emptyHarvest());
  try {
    const resolved = await resolveIdentifiers(plan);
    assert.deepEqual(resolved.server.submodel, []);
  } finally {
    restore();
  }
});

test("resolveIdentifiers pre-generates create candidates with headroom over the expected count", async () => {
  const timeline = timelineWith(
    new Track({
      id: "t",
      label: "T",
      loads: [
        new Load({
          id: "l",
          startSeconds: 0,
          durationSeconds: 60,
          shape: new ConstantShape({ ratePerSec: 10 }),
          requests: new RequestComposition([spec("c1", "create", "shell", 1)]),
        }),
      ],
    }),
  );
  const { plan } = compileTimeline(timeline, { target: TARGET });

  const resolved = await resolveIdentifiers(plan);
  // 10 req/s for 60s is 600 expected creates; the pool must have real headroom over that so a run
  // that fires a little hotter than estimated does not wrap onto an id it already used.
  assert.ok(resolved.created.shell.length > 600, `expected headroom over 600, got ${resolved.created.shell.length}`);
  assert.ok(resolved.created.shell.every((id) => id.startsWith("https://kaigara.dev/ids/shell/")));
  assert.equal(new Set(resolved.created.shell).size, resolved.created.shell.length, "every candidate must be unique");
  assert.deepEqual(resolved.created.submodel, [], "nothing in this plan creates a submodel");
});

test("the generated script embeds resolved identifiers and fetches nothing itself", async () => {
  const { plan } = compileTimeline(loadWith(serverSourced("r1", "read", "submodel", { maxIds: 2500 })), { target: TARGET });

  const restore = mockFetch(() => ({ status: 200, body: { result: [{ id: "urn:sm:1" }], paging_metadata: {} } }));
  let script: string;
  try {
    const resolved = await resolveIdentifiers(plan);
    script = compileK6Script(plan, resolved, { summaryPath: "/tmp/summary.json" });
  } finally {
    restore();
  }

  assert.match(script, /const SERVER_IDS = \{"shell":\[\],"submodel":\["urn:sm:1"\]\}/);
  assert.doesNotMatch(script, /http\.get\(/, "the script must not page anything itself");
  assert.doesNotMatch(script, /exec\.test\.abort/, "an empty harvest now fails compilation, not the running script");
  assert.match(script, /source === "server"/, "server-sourced requests must still ignore this run's own creates");
});

