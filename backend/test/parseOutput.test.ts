import test from "node:test";
import assert from "node:assert/strict";

import { K6OutputParser, readSummaryTotals } from "../src/engines/k6/parseOutput.ts";

const START = Date.parse("2026-09-03T12:00:00.000Z");

function point(metric: string, value: number, tags: Record<string, string>, offsetMs = 0): string {
  return JSON.stringify({
    type: "Point",
    metric,
    data: { time: new Date(START + offsetMs).toISOString(), value, tags },
  });
}

const REQUEST_TAGS = { load: "base__l1__0", track: "base", op: "query", target: "shell", status: "200", expected_response: "true" };

test("http_req_duration points become samples with offsets relative to the run start", () => {
  const parser = new K6OutputParser(START);
  const { samples } = parser.push(`${point("http_req_duration", 12.5, REQUEST_TAGS, 2500)}\n`);

  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], {
    offsetMs: 2500,
    loadKey: "base__l1__0",
    operation: "query",
    target: "shell",
    durationMs: 12.5,
    status: 200,
    failed: false,
  });
});

test("a request whose status was not expected is marked failed", () => {
  const parser = new K6OutputParser(START);
  const { samples } = parser.push(
    `${point("http_req_duration", 3, { ...REQUEST_TAGS, status: "404", expected_response: "false" })}\n`,
  );

  assert.equal(samples[0].failed, true);
  assert.equal(samples[0].status, 404);
});

test("a transport failure with no status becomes status 0 rather than NaN", () => {
  const parser = new K6OutputParser(START);
  const { samples } = parser.push(
    `${point("http_req_duration", 0, { load: "l", op: "create", target: "shell", status: "0", expected_response: "false" })}\n`,
  );

  assert.equal(samples[0].status, 0);
  assert.equal(samples[0].failed, true);
});

test("the tool's own setup requests are excluded from the measurement", () => {
  const parser = new K6OutputParser(START);
  const { samples } = parser.push(
    [
      // Pool seeding issued by the generated script's setup() on Kaigara's behalf.
      point("http_req_duration", 5, { load: "__kaigara_setup", status: "200", expected_response: "true" }),
      // A point with no load tag belongs to no planned load.
      point("http_req_duration", 5, { status: "200", expected_response: "true" }),
      point("http_req_duration", 5, REQUEST_TAGS),
    ].join("\n") + "\n",
  );

  assert.equal(samples.length, 1, "only the request belonging to a planned load may be counted");
  assert.equal(samples[0].loadKey, "base__l1__0");
});

test("dropped iterations and skipped requests are tallied separately from samples", () => {
  const parser = new K6OutputParser(START);
  const batch = parser.push(
    [
      point("dropped_iterations", 4, {}),
      point("kaigara_skipped_no_id", 1, { load: "base__l1__0", op: "delete" }),
      point("kaigara_skipped_no_id", 1, { load: "base__l1__0", op: "delete" }),
      point("http_req_duration", 7, REQUEST_TAGS),
    ].join("\n") + "\n",
  );

  assert.equal(batch.droppedIterations, 4);
  assert.equal(batch.skippedNoId, 2);
  assert.equal(batch.samples.length, 1);
});

test("a line split across two chunks is reassembled, not dropped", () => {
  const parser = new K6OutputParser(START);
  const line = point("http_req_duration", 9, REQUEST_TAGS);
  const cut = Math.floor(line.length / 2);

  assert.equal(parser.push(line.slice(0, cut)).samples.length, 0, "a partial line must be held back");
  const second = parser.push(`${line.slice(cut)}\n`);
  assert.equal(second.samples.length, 1);
  assert.equal(second.samples[0].durationMs, 9);
});

test("a trailing line with no newline is recovered by flush()", () => {
  const parser = new K6OutputParser(START);
  assert.equal(parser.push(point("http_req_duration", 4, REQUEST_TAGS)).samples.length, 0);
  assert.equal(parser.flush().samples.length, 1);
  assert.equal(parser.flush().samples.length, 0, "flush must not replay what it already emitted");
});

test("unparseable and irrelevant lines are skipped without failing the run", () => {
  const parser = new K6OutputParser(START);
  const batch = parser.push(
    [
      "not json at all",
      JSON.stringify({ type: "Metric", metric: "http_req_duration", data: { name: "http_req_duration" } }),
      point("vus", 10, {}),
      point("http_req_duration", 6, REQUEST_TAGS),
    ].join("\n") + "\n",
  );

  assert.equal(batch.samples.length, 1);
});

test("summary totals are read from k6's handleSummary shape", () => {
  const totals = readSummaryTotals({
    metrics: {
      http_reqs: { values: { count: 415 } },
      // k6's http_req_failed is a Rate; `passes` counts the requests that failed the expectation.
      http_req_failed: { values: { passes: 2, fails: 413 } },
      http_req_duration: { values: { avg: 0.89, "p(95)": 2.03, "p(99)": 4.46, max: 9.49 } },
      dropped_iterations: { values: { count: 0 } },
    },
  });

  assert.ok(totals);
  assert.equal(totals.requests, 415);
  assert.equal(totals.failed, 2);
  assert.equal(totals.durationMs.p95, 2.03);
  assert.equal(totals.droppedIterations, 0);
});

test("a summary that is not k6's shape returns null rather than inventing zeros", () => {
  assert.equal(readSummaryTotals(null), null);
  assert.equal(readSummaryTotals({}), null);
  assert.equal(readSummaryTotals("nope"), null);
});
