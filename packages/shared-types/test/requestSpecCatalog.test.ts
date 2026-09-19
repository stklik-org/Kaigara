import test from "node:test";
import assert from "node:assert/strict";

import {
  ConstantShape,
  Load,
  LoadTimeline,
  RandomizedGenerator,
  RequestComposition,
  RequestSpec,
  Track,
  collectLoadTimelineIssues,
  hasErrors,
  parseLoadTimeline,
} from "../src/index.ts";

/**
 * `templateId`/`bindings` record which catalogue pattern a request was authored from. They are
 * additive: the executable fields are unchanged, and a document written before the catalogue
 * existed must still round-trip byte-identically — the Compose screen's two views and the run
 * payload are the same bytes, so a stray `"templateId": undefined` would be a real bug.
 */

function timelineWith(spec: RequestSpec): LoadTimeline {
  return new LoadTimeline({
    totalDurationSeconds: 60,
    tracks: [
      new Track({
        id: "t1",
        label: "Submodels",
        color: "#2977d6",
        loads: [
          new Load({
            id: "l1",
            startSeconds: 0,
            durationSeconds: 60,
            shape: new ConstantShape({ ratePerSec: 10 }),
            requests: new RequestComposition([spec]),
          }),
        ],
      }),
    ],
  });
}

const catalogueSpec = () =>
  new RequestSpec({
    id: "read-submodel-1",
    operation: "read",
    target: "submodel",
    weight: 25,
    generator: RandomizedGenerator.createDefault(),
    templateId: "read-submodel",
    bindings: { smId: { strategy: "random-existing", config: { pool: "created", skew: "uniform" } } },
  });

test("a catalogue-authored request round-trips through JSON", () => {
  const before = timelineWith(catalogueSpec());
  const after = parseLoadTimeline(JSON.parse(JSON.stringify(before)));
  const spec = after.tracks[0].loads[0].requests.requests[0];

  assert.equal(spec.templateId, "read-submodel");
  assert.deepEqual(spec.bindings, {
    smId: { strategy: "random-existing", config: { pool: "created", skew: "uniform" } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
});

test("a request without a catalogue origin serializes without the keys", () => {
  const spec = new RequestSpec({
    id: "legacy",
    operation: "query",
    target: "shell",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
  });

  const json = spec.toJSON() as Record<string, unknown>;
  assert.equal("templateId" in json, false);
  assert.equal("bindings" in json, false);
});

test("read is a first-class operation", () => {
  const issues = collectLoadTimelineIssues(JSON.parse(JSON.stringify(timelineWith(catalogueSpec()))));
  assert.equal(hasErrors(issues), false, JSON.stringify(issues));
});

test("bindings without a templateId are an error, not a silent orphan", () => {
  const document = JSON.parse(JSON.stringify(timelineWith(catalogueSpec()))) as {
    tracks: { loads: { requests: { requests: Record<string, unknown>[] } }[] }[];
  };
  delete document.tracks[0].loads[0].requests.requests[0].templateId;

  const issues = collectLoadTimelineIssues(document);
  assert.equal(hasErrors(issues), true);
  assert.match(issues.map((issue) => issue.message).join("\n"), /templateId is required/);
});

test("a malformed binding is reported at its own path", () => {
  const document = JSON.parse(JSON.stringify(timelineWith(catalogueSpec()))) as {
    tracks: { loads: { requests: { requests: Record<string, unknown>[] } }[] }[];
  };
  document.tracks[0].loads[0].requests.requests[0].bindings = { smId: { strategy: 42 } };

  const issues = collectLoadTimelineIssues(document);
  assert.equal(hasErrors(issues), true);
  assert.ok(
    issues.some((issue) => issue.path.endsWith("bindings/smId/strategy")),
    JSON.stringify(issues),
  );
});

test("an id pool sourced from the server round-trips", () => {
  const spec = new RequestSpec({
    id: "read-1",
    operation: "read",
    target: "submodel",
    weight: 10,
    generator: RandomizedGenerator.createDefault(),
    idPool: { source: "server", maxIds: 5000 },
  });

  const after = parseLoadTimeline(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.deepEqual(after.tracks[0].loads[0].requests.requests[0].idPool, {
    source: "server",
    maxIds: 5000,
  });
});

test("an id pool with a stale onEmpty key is rejected", () => {
  const document = JSON.parse(JSON.stringify(timelineWith(catalogueSpec()))) as {
    tracks: { loads: { requests: { requests: Record<string, unknown>[] } }[] }[];
  };
  document.tracks[0].loads[0].requests.requests[0].idPool = { source: "server", onEmpty: "abort" };

  const issues = collectLoadTimelineIssues(document);
  assert.equal(hasErrors(issues), true);
  assert.ok(
    issues.some((issue) => issue.path.endsWith("idPool/onEmpty")),
    JSON.stringify(issues),
  );
});

test("an id pool on an operation that addresses no identifier is a warning, not an error", () => {
  // query pages a whole collection and never draws from a pool — unlike create, which is now the
  // one exception where an id pool means something ("duplicate an existing identifier on purpose").
  const spec = new RequestSpec({
    id: "query-1",
    operation: "query",
    target: "submodel",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
    idPool: { source: "server" },
  });

  const issues = collectLoadTimelineIssues(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.equal(hasErrors(issues), false);
  assert.match(issues.map((issue) => issue.message).join("\n"), /does not address an entity by identifier/);
});

test("an id pool on a create is valid — it means \"duplicate an existing identifier\"", () => {
  const spec = new RequestSpec({
    id: "create-1",
    operation: "create",
    target: "shell",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
    idPool: { source: "server" },
  });

  const issues = collectLoadTimelineIssues(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.deepEqual(issues, []);
});

test("a mint id format round-trips", () => {
  const spec = new RequestSpec({
    id: "create-1",
    operation: "create",
    target: "shell",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
    mintId: { format: "urn:kaigara:aas:<Num>" },
  });

  const after = parseLoadTimeline(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.deepEqual(after.tracks[0].loads[0].requests.requests[0].mintId, { format: "urn:kaigara:aas:<Num>" });
});

test("a mint id format without the <Num> placeholder is a warning, not an error", () => {
  const spec = new RequestSpec({
    id: "create-1",
    operation: "create",
    target: "shell",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
    mintId: { format: "urn:kaigara:aas:fixed" },
  });

  const issues = collectLoadTimelineIssues(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.equal(hasErrors(issues), false);
  assert.ok(
    issues.some((issue) => issue.path.endsWith("mintId/format") && issue.severity === "warning"),
    JSON.stringify(issues),
  );
});

test("a mint id on a non-create is a warning, not an error", () => {
  const spec = new RequestSpec({
    id: "read-1",
    operation: "read",
    target: "shell",
    weight: 1,
    generator: RandomizedGenerator.createDefault(),
    mintId: { format: "urn:kaigara:aas:<Num>" },
  });

  const issues = collectLoadTimelineIssues(JSON.parse(JSON.stringify(timelineWith(spec))));
  assert.equal(hasErrors(issues), false);
  assert.match(issues.map((issue) => issue.message).join("\n"), /never consulted by "read"/);
});

test("an unknown id pool source is rejected", () => {
  const document = JSON.parse(JSON.stringify(timelineWith(catalogueSpec()))) as {
    tracks: { loads: { requests: { requests: Record<string, unknown>[] } }[] }[];
  };
  document.tracks[0].loads[0].requests.requests[0].idPool = { source: "wherever" };

  const issues = collectLoadTimelineIssues(document);
  assert.equal(hasErrors(issues), true);
  assert.ok(
    issues.some((issue) => issue.path.endsWith("idPool/source")),
    JSON.stringify(issues),
  );
});

