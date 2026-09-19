import test from "node:test";
import assert from "node:assert/strict";

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
  collectLoadTimelineIssues,
  hasErrors,
  parseLoadTimeline,
} from "../src/index.ts";

/** Exercises every LoadShape kind, every RequestGenerator kind, and both the coloured and
 *  palette-default Track cases — the shapes the Compose screen can actually produce. */
function buildKitchenSinkTimeline(): LoadTimeline {
  return new LoadTimeline({
    totalDurationSeconds: 600,
    tracks: [
      new Track({
        id: "ramp",
        label: "Ramp up/down",
        // A user-picked colour: the case that used to fail schema validation on the way back in.
        color: "#3b82f6",
        loads: [
          new Load({
            id: "l-ramp-up",
            startSeconds: 0,
            durationSeconds: 20,
            shape: new RampShape({ direction: "up", fromRatePerSec: 0, toRatePerSec: 380 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r1",
                operation: "create",
                target: "shell",
                weight: 5,
                // A real pool (more than one entry) — the case sizeBytesPool exists for, not the
                // ordinary single-size generator every other RequestSpec below still uses.
                generator: new RandomizedGenerator({ sizeBytes: 256, sizeBytesPool: [256, 4096] }),
              }),
              new RequestSpec({
                id: "r2",
                operation: "query",
                target: "shell",
                weight: 95,
                generator: new RandomizedGenerator({ sizeBytes: 0 }),
              }),
            ]),
          }),
          new Load({
            id: "l-ramp-down",
            startSeconds: 20,
            durationSeconds: 20,
            shape: new RampShape({ direction: "down", fromRatePerSec: 380, toRatePerSec: 0 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r3",
                operation: "update",
                target: "submodel",
                weight: 1,
                generator: new MutateGenerator({ baseValue: '{"a":1}', mutationRatePercent: 25 }),
              }),
            ]),
          }),
        ],
      }),
      new Track({
        // No colour: exercises the `color` key being absent rather than present-and-undefined.
        id: "mixed",
        label: "Mixed shapes",
        loads: [
          new Load({
            id: "l-const",
            startSeconds: 0,
            durationSeconds: 600,
            shape: new ConstantShape({ ratePerSec: 100 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r4",
                operation: "query",
                target: "shell",
                weight: 1,
                generator: new ExactGenerator({ value: '{"idShort":"fixed"}' }),
              }),
            ]),
          }),
          new Load({
            id: "l-sine",
            startSeconds: 60,
            durationSeconds: 35,
            shape: new SineShape({ baseRatePerSec: 200, amplitudeRatePerSec: 100, direction: "rise" }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r5",
                operation: "delete",
                target: "submodel",
                weight: 1,
                generator: new RandomizedGenerator({ sizeBytes: 0 }),
              }),
            ]),
          }),
          new Load({
            id: "l-bell",
            startSeconds: 240,
            durationSeconds: 84,
            shape: new BellShape({ peakRatePerSec: 400 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r6",
                operation: "create",
                target: "submodel",
                weight: 1,
                generator: new RandomizedGenerator({ sizeBytes: 1024 }),
              }),
            ]),
          }),
          new Load({
            id: "l-spike",
            startSeconds: 90,
            durationSeconds: 0,
            shape: new SpikeShape({ magnitudeRatePerSec: 250 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r7",
                operation: "create",
                target: "submodel",
                weight: 1,
                generator: new RandomizedGenerator({ sizeBytes: 256 }),
              }),
            ]),
          }),
          new Load({
            id: "l-individual",
            startSeconds: 250,
            durationSeconds: 0,
            shape: new IndividualShape({ requestCount: 3 }),
            requests: new RequestComposition([
              new RequestSpec({
                id: "r8",
                operation: "create",
                target: "shell",
                weight: 1,
                generator: new RandomizedGenerator({ sizeBytes: 128 }),
              }),
            ]),
          }),
        ],
      }),
    ],
  });
}

test("a timeline the app itself produces round-trips through text without loss", () => {
  const original = buildKitchenSinkTimeline();

  const text = JSON.stringify(original, null, 2);
  const reparsed = parseLoadTimeline(JSON.parse(text));
  const textAgain = JSON.stringify(reparsed, null, 2);

  assert.equal(textAgain, text, "text -> timeline -> text must be a fixed point");
  assert.deepEqual(reparsed.toJSON(), original.toJSON());
});

test("round-tripping rebuilds real class instances, not plain objects", () => {
  const reparsed = parseLoadTimeline(JSON.parse(JSON.stringify(buildKitchenSinkTimeline())));

  assert.ok(reparsed instanceof LoadTimeline);
  assert.ok(reparsed.tracks[0] instanceof Track);
  assert.ok(reparsed.tracks[0].loads[0] instanceof Load);
  assert.ok(reparsed.tracks[0].loads[0].shape instanceof RampShape);
  assert.ok(reparsed.tracks[0].loads[0].requests instanceof RequestComposition);
  assert.ok(reparsed.tracks[0].loads[0].requests.requests[0] instanceof RequestSpec);
  assert.ok(reparsed.tracks[0].loads[0].requests.requests[0].generator instanceof RandomizedGenerator);

  // The payoff of it being a real instance: polymorphic rateAt() still works after a round trip,
  // which is what both the overlay chart and the backend's plan compiler depend on.
  assert.equal(reparsed.tracks[0].loads[0].shape.rateAt(10, 20), 190);
});

test("a user-picked track colour survives the round trip and validates clean", () => {
  const original = buildKitchenSinkTimeline();
  const issues = collectLoadTimelineIssues(original.toJSON());

  assert.equal(
    issues.filter((i) => i.severity === "error").length,
    0,
    `a document the app just emitted must validate without errors, got: ${JSON.stringify(issues)}`,
  );

  const reparsed = parseLoadTimeline(JSON.parse(JSON.stringify(original)));
  assert.equal(reparsed.tracks[0].color, "#3b82f6");
  assert.equal(reparsed.tracks[1].color, undefined);
});

test("an exchange capture setting survives the round trip, and is absent from the document when unset", () => {
  const plain = buildKitchenSinkTimeline();
  assert.equal("capture" in plain.toJSON(), false, "the default must not appear in documents that never chose one");

  const chosen = plain.with({ capture: { mode: "capped-sampled", storeAllErrors: true } });
  const reparsed = parseLoadTimeline(JSON.parse(JSON.stringify(chosen)));
  assert.deepEqual(reparsed.capture, { mode: "capped-sampled", storeAllErrors: true });
  assert.equal(reparsed.with({ capture: undefined }).toJSON().capture, undefined);

  const bad = collectLoadTimelineIssues({ ...plain.toJSON(), capture: { mode: "everything", storeAllErrors: "yes", extra: 1 } });
  assert.deepEqual(
    bad.filter((i) => i.severity === "error").map((i) => i.path).sort(),
    ["capture/extra", "capture/mode", "capture/storeAllErrors"],
  );
});

test("structural problems are reported as errors, with the path to the offending value", () => {
  const cases: { mutate: (doc: any) => void; expectPath: string; expect: RegExp }[] = [
    {
      mutate: (doc) => delete doc.tracks[0].loads[0].startSeconds,
      expectPath: "tracks/0/loads/0/startSeconds",
      expect: /expected a finite number/,
    },
    {
      mutate: (doc) => (doc.tracks[0].loads[0].durationSeconds = "20"),
      expectPath: "tracks/0/loads/0/durationSeconds",
      expect: /expected a finite number/,
    },
    {
      mutate: (doc) => (doc.tracks[0].loads[0].shape.kind = "sawtooth"),
      expectPath: "tracks/0/loads/0/shape/kind",
      expect: /expected one of/,
    },
    {
      mutate: (doc) => (doc.tracks[0].loads[0].shape.rateePerSec = 5),
      expectPath: "tracks/0/loads/0/shape/rateePerSec",
      expect: /unknown property/,
    },
    {
      mutate: (doc) => (doc.tracks[0].loads[0].requests.requests[0].operation = "upsert"),
      expectPath: "tracks/0/loads/0/requests/requests/0/operation",
      expect: /expected one of/,
    },
    {
      mutate: (doc) => (doc.tracks[0].loads[0].startSeconds = -5),
      expectPath: "tracks/0/loads/0/startSeconds",
      expect: /must be >= 0/,
    },
    {
      mutate: (doc) => (doc.totalDurationSeconds = "ten minutes"),
      expectPath: "totalDurationSeconds",
      expect: /expected a finite number/,
    },
  ];

  for (const { mutate, expectPath, expect } of cases) {
    const doc = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
    mutate(doc);
    const issues = collectLoadTimelineIssues(doc);
    assert.ok(hasErrors(issues), `expected an error for ${expectPath}, got ${JSON.stringify(issues)}`);
    const match = issues.find((i) => i.path === expectPath && i.severity === "error");
    assert.ok(match, `expected an error at "${expectPath}", got ${JSON.stringify(issues)}`);
    assert.match(match.message, expect);
  }
});

test("duplicate load ids are an error — they would silently merge two loads' metrics", () => {
  const doc: any = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
  doc.tracks[1].loads[0].id = "l-ramp-up";

  const issues = collectLoadTimelineIssues(doc);
  const duplicate = issues.find((i) => i.severity === "error" && /duplicate load id/.test(i.message));

  assert.ok(duplicate, `expected a duplicate-id error, got ${JSON.stringify(issues)}`);
  assert.equal(duplicate.path, "tracks/1/loads/0/id");
});

test("duplicate track ids are an error", () => {
  const doc: any = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
  doc.tracks[1].id = "ramp";

  const issues = collectLoadTimelineIssues(doc);
  assert.ok(issues.some((i) => i.severity === "error" && /duplicate track id/.test(i.message)));
});

test("coherent-but-pointless documents produce warnings, not errors", () => {
  const doc: any = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
  doc.tracks[0].loads[0].requests.requests = []; // sends nothing
  doc.tracks[1].loads[1].startSeconds = 590; // sine runs past totalDurationSeconds
  doc.tracks[1].loads[3].durationSeconds = 30; // spike is instantaneous; duration is meaningless

  const issues = collectLoadTimelineIssues(doc);

  assert.equal(hasErrors(issues), false, `expected warnings only, got ${JSON.stringify(issues)}`);
  assert.ok(issues.some((i) => /will generate no traffic/.test(i.message)));
  assert.ok(issues.some((i) => /past the timeline's totalDurationSeconds/.test(i.message)));
  assert.ok(issues.some((i) => /fires once rather than sustaining a rate/.test(i.message)));
});

test("all-zero request weights warn — nothing could ever be selected", () => {
  const doc: any = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
  for (const request of doc.tracks[0].loads[0].requests.requests) request.weight = 0;

  const issues = collectLoadTimelineIssues(doc);
  assert.equal(hasErrors(issues), false);
  assert.ok(issues.some((i) => /weights sum to 0/.test(i.message)));
});

test("parseLoadTimeline throws TimelineValidationError carrying every issue", () => {
  const doc: any = JSON.parse(JSON.stringify(buildKitchenSinkTimeline()));
  delete doc.tracks[0].loads[0].startSeconds;
  doc.tracks[1].loads[0].shape.kind = "nope";

  assert.throws(
    () => parseLoadTimeline(doc),
    (error: unknown) => {
      assert.ok(error instanceof TimelineValidationError);
      assert.ok(error.issues.filter((i) => i.severity === "error").length >= 2);
      assert.match(error.message, /Timeline validation failed \(2 errors\)/);
      return true;
    },
  );
});

test("non-object input is rejected rather than throwing a TypeError deep in a constructor", () => {
  for (const input of [null, 42, "a string", [], undefined]) {
    const issues = collectLoadTimelineIssues(input);
    assert.ok(hasErrors(issues), `expected ${JSON.stringify(input) ?? "undefined"} to be rejected`);
  }
});
