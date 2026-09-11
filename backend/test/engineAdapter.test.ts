/**
 * The adapter seam after ADR 0004: an adapter compiles the authored timeline itself and hands back
 * a thin `CompiledRun`, and `RunService` never records a run whose compile failed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ConstantShape,
  Load,
  LoadTimeline,
  RandomizedGenerator,
  RequestComposition,
  RequestSpec,
  Track,
  type EngineId,
} from "@kaigara/shared-types";

import {
  EngineRegistry,
  type CompiledRun,
  type EngineAdapter,
  type EngineRunContext,
  type EngineRunHandle,
} from "../src/engines/adapter.ts";
import { EmptyPlanError, K6Adapter } from "../src/engines/k6/k6Adapter.ts";
import { RunService } from "../src/runs/runService.ts";

const TARGET = { baseUrl: "http://127.0.0.1:8081/api/v3", timeoutSeconds: 30, headers: {} };

function timeline(requests: RequestSpec[]): ReturnType<LoadTimeline["toJSON"]> {
  return new LoadTimeline({
    totalDurationSeconds: 60,
    tracks: [
      new Track({
        id: "t1",
        label: "Track 1",
        loads: [
          new Load({
            id: "l1",
            startSeconds: 5,
            durationSeconds: 30,
            shape: new ConstantShape({ ratePerSec: 10 }),
            requests: new RequestComposition(requests),
          }),
        ],
      }),
    ],
  }).toJSON();
}

function spec(id: string, operation: RequestSpec["operation"]): RequestSpec {
  return new RequestSpec({ id, operation, target: "shell", weight: 1, generator: new RandomizedGenerator({ sizeBytes: 64 }) });
}

/** Keeps `resolveIdentifiers`'s compile-time harvest off the network for the duration of a test. */
function withEmptyHarvest(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: [], paging_metadata: {} }), { status: 200 })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("K6Adapter.compile() works straight from the timeline and returns a thin summary", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "kaigara-adapter-"));
  const workDir = join(scratch, "run");
  await mkdir(workDir, { recursive: true });
  const restore = withEmptyHarvest();

  try {
    const adapter = new K6Adapter({ logDir: join(scratch, "k6-logs") });
    const compiled = await adapter.compile({
      runId: "run-1",
      timeline: timeline([spec("q", "query"), spec("c", "create")]),
      target: TARGET,
      scenarioName: "  Adapter seam  ",
      workDir,
    });

    // The summary is everything RunService needs and nothing about executors or HTTP mapping.
    assert.equal(compiled.summary.scenarioName, "Adapter seam", "the name is trimmed by the adapter's own compile");
    assert.equal(compiled.summary.totalDurationSeconds, 60);
    assert.equal(compiled.summary.expectedRequests, 300, "10 req/s for 30s");
    assert.deepEqual(Object.keys(compiled.summary.loads[0]).sort(), [
      "key",
      "label",
      "loadId",
      "requestCount",
      "startSeconds",
      "trackId",
    ]);
    assert.equal(compiled.summary.loads[0].loadId, "l1");
    assert.equal(compiled.summary.loads[0].startSeconds, 5);
    assert.equal(compiled.summary.loads[0].requestCount, 2);

    // Both artifacts are written, and plan.json is the adapter's own k6 form.
    assert.deepEqual(compiled.artifacts.map((a) => a.name).sort(), ["plan.json", "script.js"]);
    const planJson = JSON.parse(await readFile(join(workDir, "plan.json"), "utf8"));
    assert.equal(planJson.loads[0].executor.executor, "constant-arrival-rate");
    assert.equal(planJson.loads[0].key, compiled.summary.loads[0].key, "summary keys tag the same loads as the plan");
  } finally {
    restore();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("K6Adapter.compile() refuses a timeline with nothing to execute", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "kaigara-adapter-"));
  const restore = withEmptyHarvest();
  try {
    const adapter = new K6Adapter({ logDir: join(scratch, "k6-logs") });
    await assert.rejects(
      () => adapter.compile({ runId: "run-empty", timeline: timeline([]), target: TARGET, workDir: scratch }),
      EmptyPlanError,
    );
  } finally {
    restore();
    await rm(scratch, { recursive: true, force: true });
  }
});

/** An adapter that is always available and whose compile always fails — to observe what
 *  RunService does when compilation throws, without needing k6 installed. */
class FailingCompileAdapter implements EngineAdapter {
  readonly id: EngineId = "k6";
  readonly name = "fails to compile";
  lastWorkDir: string | null = null;

  async probe() {
    return { available: true, detail: "fake" };
  }

  async compile(context: EngineRunContext): Promise<CompiledRun> {
    this.lastWorkDir = context.workDir;
    throw new EmptyPlanError("nothing to run");
  }

  async start(): Promise<EngineRunHandle> {
    throw new Error("start() must never be reached when compile() failed");
  }
}

test("a run whose compile fails is never recorded, and its work directory is removed", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "kaigara-runs-"));
  try {
    const engines = new EngineRegistry();
    const adapter = new FailingCompileAdapter();
    engines.register(adapter);
    const runs = new RunService(engines, workRoot);

    await assert.rejects(() => runs.create({ timeline: timeline([]), target: TARGET }), EmptyPlanError);

    assert.deepEqual(runs.list(), [], "no ghost run left in 'starting'");
    assert.ok(adapter.lastWorkDir, "the adapter was handed a work directory");
    assert.deepEqual(await readdir(workRoot), [], "and that directory was cleaned up");
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
