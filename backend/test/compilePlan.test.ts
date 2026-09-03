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

import { compilePlan } from "../src/timeline/compilePlan.ts";
import { compileK6Script } from "../src/engines/k6/compileScript.ts";
import { describeOperation } from "../src/timeline/aasOperations.ts";

const TARGET = { baseUrl: "http://127.0.0.1:8081/api/v3", timeoutSeconds: 30, headers: {} };

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

test("a ramp compiles to a single linear segment that reproduces it exactly", () => {
  const { plan } = compilePlan(singleLoad(new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 380 }), 20), {
    target: TARGET,
  });

  assert.equal(plan.loads.length, 1);
  const execution = plan.loads[0].execution;
  assert.equal(execution.mode, "rate");
  if (execution.mode !== "rate") return;

  assert.equal(execution.profile.startRatePerSec, 0);
  assert.deepEqual(execution.profile.segments, [{ durationSeconds: 20, toRatePerSec: 380 }]);
  assert.equal(execution.profile.peakRatePerSec, 380);
  assert.equal(execution.profile.flat, false);

  // Area under a 0→380 ramp over 20s.
  assert.equal(plan.expectedRequests, 3800);
});

test("a constant load is detected as flat so the adapter can use a cheaper executor", () => {
  const { plan } = compilePlan(singleLoad(new ConstantShape({ ratePerSec: 100 }), 600), { target: TARGET });
  const execution = plan.loads[0].execution;
  assert.equal(execution.mode, "rate");
  if (execution.mode !== "rate") return;

  assert.equal(execution.profile.flat, true);
  assert.equal(execution.profile.startRatePerSec, 100);
  assert.equal(plan.expectedRequests, 60_000);
});

test("a sine is approximated by many segments whose integral matches the analytic area", () => {
  const durationSeconds = 40;
  const peak = 300;
  const { plan } = compilePlan(singleLoad(new SineShape({ peakRatePerSec: peak }), durationSeconds), { target: TARGET });

  const execution = plan.loads[0].execution;
  assert.equal(execution.mode, "rate");
  if (execution.mode !== "rate") return;

  assert.ok(execution.profile.segments.length > 1, "a curve must not collapse to one segment");
  assert.equal(execution.profile.peakRatePerSec, peak);
  // Integral of peak*sin(pi*t/D) over [0,D] is 2*peak*D/pi.
  const analytic = (2 * peak * durationSeconds) / Math.PI;
  const relativeError = Math.abs(plan.expectedRequests - analytic) / analytic;
  assert.ok(relativeError < 0.01, `piecewise-linear error ${relativeError} should be under 1%`);
});

test("a bell curve peaks at its configured magnitude", () => {
  const { plan } = compilePlan(singleLoad(new BellShape({ peakRatePerSec: 400 }), 84), { target: TARGET });
  const execution = plan.loads[0].execution;
  if (execution.mode !== "rate") return assert.fail("expected a rate profile");
  assert.ok(execution.profile.peakRatePerSec > 390, `peak ${execution.profile.peakRatePerSec} should approach 400`);
});

test("a spike is spread over the same window the Compose overlay previews it with", () => {
  const { plan } = compilePlan(singleLoad(new SpikeShape({ magnitudeRatePerSec: 250 }), 0, 90), { target: TARGET });
  const execution = plan.loads[0].execution;
  assert.equal(execution.mode, "rate");
  if (execution.mode !== "rate") return;

  assert.equal(execution.profile.durationSeconds, INSTANTANEOUS_WINDOW_SECONDS);
  assert.equal(plan.loads[0].startSeconds, 90);
  assert.equal(plan.expectedRequests, 250 * INSTANTANEOUS_WINDOW_SECONDS);
});

test("an individual load becomes a literal iteration count, not a rate", () => {
  const { plan } = compilePlan(singleLoad(new IndividualShape({ requestCount: 3 }), 0, 250), { target: TARGET });
  const execution = plan.loads[0].execution;

  assert.equal(execution.mode, "fixed");
  if (execution.mode !== "fixed") return;
  assert.equal(execution.iterations, 3);
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

  const { plan } = compilePlan(timeline, { target: TARGET });
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

  const { plan, warnings } = compilePlan(timeline, { target: TARGET });

  assert.equal(plan.loads.length, 1);
  assert.equal(plan.loads[0].loadId, "l-real");
  assert.ok(warnings.some((w) => /no requests/.test(w.message)), "the user should be told why it vanished");
});

test("an invalid timeline is rejected before any script is generated", () => {
  const broken = { totalDurationSeconds: 600, tracks: [{ id: "t", label: "T", loads: [{ id: "l" }] }] };
  assert.throws(() => compilePlan(broken as never, { target: TARGET }), TimelineValidationError);
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

  const { plan } = compilePlan(timeline, { target: TARGET });
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

  const { plan } = compilePlan(timeline, { target: TARGET, scenarioName: "syntax-check" });
  const script = compileK6Script(plan, { summaryPath: "/tmp/summary.json" });

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
