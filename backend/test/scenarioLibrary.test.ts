import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TRACK_COLOR_PALETTE, collectLoadTimelineIssues } from "@kaigara/shared-types";
import { ScenarioNotFoundError, listScenarios, readScenario } from "../src/scenarios/library.ts";

const BUNDLED = resolve(fileURLToPath(new URL("../scenarios", import.meta.url)));

/** The shipped scenarios are hand-editable data files, so nothing but a test stops a stray edit
 *  from shipping a document the app itself would reject. */
test("every bundled scenario loads and validates", async () => {
  const { entries } = await listScenarios(BUNDLED);
  assert.ok(entries.length > 0, "expected the bundled library to be non-empty");

  for (const entry of entries) {
    assert.equal(entry.issues, undefined, `${entry.file} has issues: ${JSON.stringify(entry.issues)}`);
    const scenario = await readScenario(entry.id, BUNDLED);
    const errors = collectLoadTimelineIssues(scenario.phases.method).filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], `${entry.file} timeline errors`);
    assert.ok(scenario.description, `${entry.file} should describe itself`);
  }
});

/** Colours belong to the document, so the shipped library has to carry them — a scenario that
 *  arrived uncoloured would be coloured by whoever opened it, and two people would then be looking
 *  at differently-coloured copies of the same benchmark. */
test("every bundled scenario carries a distinct palette colour per track", async () => {
  const { entries } = await listScenarios(BUNDLED);

  for (const entry of entries) {
    const { tracks } = (await readScenario(entry.id, BUNDLED)).phases.method;
    const colors = tracks.map((t) => t.color);

    for (const [index, color] of colors.entries()) {
      assert.ok(color, `${entry.file} track "${tracks[index].id}" has no colour`);
      assert.ok(
        TRACK_COLOR_PALETTE.includes(color),
        `${entry.file} track "${tracks[index].id}" uses ${color}, which is not a palette colour`,
      );
    }
    assert.equal(new Set(colors).size, colors.length, `${entry.file} reuses a colour across tracks`);
  }
});

test("the demo set covers the shapes the Compose screen offers", async () => {
  const showcase = await readScenario("shape-showcase", BUNDLED);
  const kinds = new Set(showcase.phases.method.tracks.flatMap((t) => t.loads.map((l) => l.shape.kind)));
  assert.deepEqual([...kinds].sort(), ["bell", "constant", "individual", "ramp", "sine", "spike"]);
});

test("the persistence probe injects once and then polls at 1 kHz", async () => {
  const scenario = await readScenario("persistence-latency", BUNDLED);
  const loads = scenario.phases.method.tracks.flatMap((t) => t.loads);

  const inject = loads.find((l) => l.shape.kind === "individual");
  assert.ok(inject, "expected a one-off injection");
  assert.equal(inject.shape.kind === "individual" && inject.shape.requestCount, 1);
  assert.deepEqual(
    inject.requests.requests.map((r) => [r.operation, r.target, r.generator.kind]),
    [["create", "shell", "exact"]],
    "the injected shell must be sent verbatim, so its identifier is known before the run",
  );

  const poll = loads.find((l) => l.shape.kind === "constant");
  assert.ok(poll, "expected a sustained poll");
  // One request per millisecond.
  assert.equal(poll.shape.kind === "constant" && poll.shape.ratePerSec, 1000);
});

test("each StressForge profile is ramp up -> hold -> ramp down on every track", async () => {
  for (const id of ["component-manufacturer", "public-website", "process-integrator"]) {
    const scenario = await readScenario(id, BUNDLED);
    const { totalDurationSeconds, tracks } = scenario.phases.method;
    assert.ok(tracks.length > 0, `${id} has no tracks`);

    for (const track of tracks) {
      assert.deepEqual(
        track.loads.map((l) => l.shape.kind),
        ["ramp", "constant", "ramp"],
        `${id}/${track.id} should follow LoadService.CreateLoadPlan's shape`,
      );
      const [up, hold, down] = track.loads;
      // A fifth of the run each way, per LoadService.CreateLoadPlan.
      assert.equal(up.durationSeconds, totalDurationSeconds / 5);
      assert.equal(down.durationSeconds, totalDurationSeconds / 5);
      assert.equal(hold.startSeconds, up.durationSeconds);
      assert.equal(down.startSeconds + down.durationSeconds, totalDurationSeconds);
      // The ramps must meet the plateau, or the timeline would step rather than ramp.
      const rate = hold.shape.kind === "constant" ? hold.shape.ratePerSec : 0;
      assert.equal(up.shape.kind === "ramp" && up.shape.toRatePerSec, rate);
      assert.equal(down.shape.kind === "ramp" && down.shape.fromRatePerSec, rate);
    }
  }
});

test("an unreadable file is listed with its issues rather than dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaigara-scenarios-"));
  await writeFile(join(dir, "broken.json"), '{"totalDurationSeconds": "ten", "tracks": []}', "utf8");
  await writeFile(join(dir, "not-json.json"), "{oops", "utf8");

  const { entries } = await listScenarios(dir);
  assert.deepEqual(entries.map((e) => e.id).sort(), ["broken", "not-json"]);
  for (const entry of entries) {
    assert.ok(entry.issues && entry.issues.length > 0, `${entry.file} should carry issues`);
  }
});

test("a scenario id cannot escape the library folder", async () => {
  for (const id of ["../package", "..%2Fpackage", "/etc/passwd", "sub/dir", ".", ""]) {
    await assert.rejects(() => readScenario(id, BUNDLED), ScenarioNotFoundError, `id ${JSON.stringify(id)}`);
  }
});

test("a missing library folder is an empty library, not an error", async () => {
  const { entries } = await listScenarios(join(tmpdir(), "kaigara-does-not-exist-ok"));
  assert.deepEqual(entries, []);
});
