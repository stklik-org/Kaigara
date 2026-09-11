import assert from "node:assert/strict";
import test from "node:test";

import { collectLoadTimelineIssues } from "@kaigara/shared-types";
import { createServer } from "../src/server.ts";
import { EXAMPLE_TARGET, EXAMPLE_TIMELINE } from "../src/routes/apiSchemas.ts";

/**
 * The OpenAPI document is what someone reads before they trust this API, and Swagger UI is how the
 * backend gets driven without the frontend. Both fail *quietly* — an unresolvable `$ref` renders as
 * an empty box, an undocumented route simply is not there, and an example that no longer validates
 * only fails once a user has pressed Execute. So these tests check the document that comes out
 * rather than the schema literals that go in.
 */

/** Built once: `createServer` starts nothing (no listen), but it does register every plugin. */
async function spec(): Promise<Record<string, any>> {
  const app = await createServer({ logger: false });
  await app.ready();
  const document = app.swagger() as Record<string, any>;
  await app.close();
  return document;
}

/** Every endpoint the server actually answers on. A route added without a schema is a route that
 *  vanishes from the docs, which is exactly the drift this list exists to catch. */
const EXPECTED_PATHS = [
  "/api/health",
  "/api/engines",
  "/api/connections/test",
  "/api/scenarios",
  "/api/scenarios/{id}",
  "/api/runs",
  "/api/runs/compile",
  "/api/runs/concrete-plan",
  "/api/runs/scenario",
  "/api/runs/{id}",
  "/api/runs/{id}/stop",
  "/api/runs/{id}/events",
  "/api/runs/{id}/artifacts/{name}",
];

test("every route is documented, and every operation says what it is for", async () => {
  const document = await spec();

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [...EXPECTED_PATHS].sort());

  for (const [path, operations] of Object.entries(document.paths as Record<string, Record<string, any>>)) {
    for (const [method, operation] of Object.entries(operations)) {
      const where = `${method.toUpperCase()} ${path}`;
      assert.ok(operation.summary, `${where} has no summary`);
      assert.ok(operation.tags?.length > 0, `${where} is untagged, so Swagger UI files it under "default"`);
    }
  }
});

/** A `$ref` is a string: a typo in one produces a valid-looking document that renders as an empty
 *  box, with no error anywhere. */
test("every $ref in the document resolves to a component that exists", async () => {
  const document = await spec();
  const known = new Set(Object.keys(document.components.schemas));
  const dangling: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string") {
        const name = value.replace("#/components/schemas/", "");
        if (value === name || !known.has(name)) dangling.push(value);
      } else {
        walk(value);
      }
    }
  };
  walk(document.paths);
  walk(document.components.schemas);

  assert.deepEqual(dangling, [], "unresolvable $refs");
});

/** The timeline half of `components.schemas` is hoisted from the generated `loadTimelineSchema`,
 *  which is the point: a field added to the metamodel appears in the docs without being restated
 *  here. If the hoisting broke, the shapes would silently go missing. */
test("the timeline metamodel is present in components, hoisted from its generated schema", async () => {
  const { components } = await spec();

  assert.ok(components.schemas.LoadTimeline, "LoadTimeline");
  assert.deepEqual(components.schemas.LoadTimeline.required, ["totalDurationSeconds", "tracks"]);
  for (const name of ["Track", "Load", "LoadShape", "ConstantShape", "RequestSpec", "RequestGenerator"]) {
    assert.ok(components.schemas[name], `${name} should be hoisted out of definitions`);
  }
  // Hoisted, not left pointing at a `definitions` section OpenAPI has no place for.
  assert.equal(components.schemas.LoadTimeline.definitions, undefined);
  assert.equal(JSON.stringify(components.schemas).includes("#/definitions/"), false);
});

/** The example is the body Swagger UI pre-fills, so a user's first click executes it. It has to be
 *  a document the validator accepts — otherwise the first thing the API does is reject its own
 *  documentation. */
test("the documented example timeline is one the validator accepts", () => {
  const errors = collectLoadTimelineIssues(EXAMPLE_TIMELINE as never).filter((issue) => issue.severity === "error");
  assert.deepEqual(errors, [], "example timeline errors");
});

/** …and one the compiler can turn into real requests: valid but empty would still be a bad example. */
test("the documented example compiles to a plan that would issue requests", async () => {
  const app = await createServer({ logger: false });
  const response = await app.inject({
    method: "POST",
    url: "/api/runs/compile",
    payload: { timeline: EXAMPLE_TIMELINE, target: EXAMPLE_TARGET },
  });
  await app.close();

  assert.equal(response.statusCode, 200, response.body);
  const { plan, script } = response.json();
  assert.ok(plan.loads.length > 0, "example should compile to at least one load");
  assert.ok(script.includes("http"), "expected a generated engine script");
});

/** The concrete-plan endpoint projects the compiled plan into one entry per load (engine
 *  scenario); the documented example has to produce entries, or the debug view opens empty. */
test("POST /api/runs/concrete-plan projects the example into per-load entries", async () => {
  const app = await createServer({ logger: false });
  const response = await app.inject({
    method: "POST",
    url: "/api/runs/concrete-plan",
    payload: { timeline: EXAMPLE_TIMELINE, target: EXAMPLE_TARGET },
  });
  await app.close();

  assert.equal(response.statusCode, 200, response.body);
  const plan = response.json();
  assert.ok(plan.entries.length > 0, "expected at least one load entry");
  assert.ok(plan.expectedRequests > 0, "expected a positive request total");
  assert.ok(
    plan.entries.every(
      (entry: {
        startSeconds: number;
        durationSeconds: number;
        executor: string;
        requests: { method: string; path: string; expectedRequests: number }[];
      }) =>
        typeof entry.startSeconds === "number" &&
        entry.durationSeconds >= 0 &&
        entry.executor.length > 0 &&
        entry.requests.length > 0 &&
        entry.requests.every((line) => line.method && line.path),
    ),
    "every entry should carry a start, duration, executor and at least one request line",
  );
});

/**
 * `documented()` attaches schemas for the docs and switches Fastify's own validation off, so that
 * `loadTimelineValidation.ts` stays the single validator. If Ajv were validating the body, this
 * would come back as a Fastify 400 with `body/tracks/0 must have property …` instead of the 422 and
 * per-path issue list the editor renders.
 */
test("an invalid timeline is rejected by the domain validator, not by Fastify's", async () => {
  const app = await createServer({ logger: false });
  const response = await app.inject({
    method: "POST",
    url: "/api/runs/compile",
    payload: {
      timeline: {
        totalDurationSeconds: 30,
        tracks: [
          {
            id: "t",
            label: "T",
            loads: [
              {
                id: "l",
                startSeconds: 0,
                durationSeconds: 5,
                shape: { kind: "nonsense" },
                requests: { requests: [] },
              },
            ],
          },
        ],
      },
      target: EXAMPLE_TARGET,
    },
  });
  await app.close();

  assert.equal(response.statusCode, 422);
  const body = response.json();
  assert.ok(
    body.issues.some((issue: { path: string }) => issue.path === "tracks/0/loads/0/shape/kind"),
    `expected a per-path issue list, got ${response.body}`,
  );
});

/** The scenario endpoint's own guards, none of which reach an engine — so this passes on a machine
 *  with no k6 installed. */
test("POST /api/runs/scenario rejects an ambiguous or unusable scenario", async () => {
  const app = await createServer({ logger: false });
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/runs/scenario", payload: payload as never });

  const neither = await post({ target: EXAMPLE_TARGET });
  assert.equal(neither.statusCode, 400, neither.body);
  // Not 422: there is no document yet to have issues with.
  assert.equal(neither.json().issues, undefined);

  const both = await post({ scenario: EXAMPLE_TIMELINE, scenarioId: "shape-showcase", target: EXAMPLE_TARGET });
  assert.equal(both.statusCode, 400, both.body);

  const missing = await post({ scenarioId: "no-such-scenario", target: EXAMPLE_TARGET });
  assert.equal(missing.statusCode, 404, missing.body);

  // A file stem cannot name anything outside the library folder.
  const traversal = await post({ scenarioId: "../../package", target: EXAMPLE_TARGET });
  assert.equal(traversal.statusCode, 404, traversal.body);

  const unusable = await post({ scenario: { not: "a scenario" }, target: EXAMPLE_TARGET });
  assert.equal(unusable.statusCode, 422, unusable.body);

  await app.close();
});

/** The `scenarioId` in the endpoint's example has to name a scenario that is actually shipped, or
 *  the pre-filled body 404s on the first click. */
test("the documented scenarioId example names a scenario in the library", async () => {
  const document = await spec();
  const example = document.paths["/api/runs/scenario"].post.requestBody.content["application/json"].schema.example;

  const app = await createServer({ logger: false });
  const response = await app.inject({ method: "GET", url: `/api/scenarios/${example.scenarioId}` });
  await app.close();

  assert.equal(response.statusCode, 200, `example names "${example.scenarioId}", which the library does not have`);
});
