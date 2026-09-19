/**
 * The adapter seam after ADR 0004: an adapter compiles the authored timeline itself and hands back
 * a thin `CompiledRun`, and `RunService` never records a run whose compile failed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { K6RunArchive } from "../src/engines/k6/runArchive.ts";
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

/** Keeps the compile-time identifier harvest off the network for the duration of a test. */
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

    // main.js, one script per request type, and the plan are all written to the work dir k6 runs in.
    // File names are k6_<track>_<load>_<request spec>, each id exactly as authored below.
    assert.deepEqual(compiled.artifacts.map((a) => a.name), [
      "main.js",
      "k6_t1_l1_q.js",
      "k6_t1_l1_c.js",
      "plan.json",
    ]);
    for (const artifact of compiled.artifacts) {
      assert.ok((await readFile(artifact.absolutePath, "utf8")).length > 0, `${artifact.name} is empty`);
    }
    const main = await readFile(join(workDir, "main.js"), "utf8");
    assert.match(main, /import \* as s01 from "\.\/k6_t1_l1_q\.js";/, "main.js imports the scripts it schedules");

    const planJson = JSON.parse(await readFile(join(workDir, "plan.json"), "utf8"));
    assert.equal(planJson.loads[0].executor.executor, "constant-arrival-rate");
    assert.equal(planJson.loads[0].key, compiled.summary.loads[0].key, "summary keys tag the same loads as the plan");
    assert.equal(planJson.loads[0].scripts.length, 2, "one script per request type");
  } finally {
    restore();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("compile() archives the authored timeline, and the run is listable and reopenable before it ever starts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "kaigara-adapter-"));
  const workDir = join(scratch, "run");
  await mkdir(workDir, { recursive: true });
  const restore = withEmptyHarvest();

  try {
    const adapter = new K6Adapter({ logDir: join(scratch, "k6-logs") });
    const authored = timeline([spec("q", "query")]);
    await adapter.compile({
      runId: "run-archive-1",
      timeline: authored,
      target: TARGET,
      scenarioName: "Archived before start",
      workDir,
    });

    const entries = await adapter.archive.list();
    const entry = entries.find((candidate) => candidate.runId === "run-archive-1");
    assert.ok(entry, "the compiled run appears in the archive listing");
    assert.equal(entry?.scenarioName, "Archived before start");
    assert.equal(entry?.targetBaseUrl, TARGET.baseUrl);
    assert.equal(entry?.status, undefined, "no terminal status yet — start() was never called");

    const reopened = await adapter.archive.read(entry!.id);
    assert.ok(reopened, "the archived run reopens by its listed id");
    assert.deepEqual(reopened?.timeline, authored, "the authored timeline round-trips byte-for-byte");
    assert.equal(reopened?.requestLog, null, "no metrics.ndjson to re-parse before the run ever started");
    assert.equal(reopened?.plan?.loadCount, 1, "the archived plan.json still resolves to a plan summary");
    assert.equal(reopened?.plan?.loads[0].loadId, "l1", "loadKey -> loadId resolves the same way a live RunView.plan does");
  } finally {
    restore();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("exchanges k6 appends to the run's log folder are found by id, live and from a fresh process", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "kaigara-adapter-"));
  const workDir = join(scratch, "run");
  await mkdir(workDir, { recursive: true });
  const restore = withEmptyHarvest();

  try {
    const adapter = new K6Adapter({ logDir: join(scratch, "k6-logs") });
    await adapter.compile({
      runId: "run-exchange-1",
      timeline: timeline([spec("q", "query")]),
      target: TARGET,
      scenarioName: "Exchange lifecycle",
      workDir,
    });
    const path = adapter.archive.exchangesPath("run-exchange-1");
    assert.ok(path, "a compiled run has a place in its log folder for k6 to write exchanges to");

    // Exactly what k6 writes with --log-format json --console-output: the message wrapped once.
    const exchange = (id: string, responseBody: string) => ({
      id,
      method: "GET",
      url: "http://127.0.0.1:8081/api/v3/shells",
      requestBody: "",
      requestTruncated: false,
      requestBytes: 0,
      status: 200,
      responseBody,
      responseTruncated: false,
      responseBytes: responseBody.length,
    });
    const line = ({ id, ...rest }: ReturnType<typeof exchange>) =>
      JSON.stringify({ level: "info", msg: `KAIGARA_EXCHANGE ${id} ${JSON.stringify(rest)}`, time: "2026-09-19T12:00:00+02:00" });

    const first = exchange("k6_t1_l1_q:0", '{"result":[]}');
    await writeFile(path, `${line(first)}\n`, "utf8");
    assert.deepEqual(await adapter.archive.exchange("run-exchange-1", first.id), first);
    assert.equal(await adapter.archive.exchange("run-exchange-1", "k6_t1_l1_q:9"), null);

    // k6 keeps appending while the run is live: a body far past one read chunk, and a line it has
    // not finished writing yet — which must not be indexed until its newline arrives.
    const big = exchange("k6_t1_l1_q:1", JSON.stringify({ blob: "x".repeat(3 * 1024 * 1024) }));
    const pending = exchange("k6_t1_l1_q:2", '{"result":["ü"]}');
    const pendingLine = line(pending);
    await appendFile(path, `${line(big)}\n${pendingLine.slice(0, 40)}`, "utf8");
    assert.deepEqual(await adapter.archive.exchange("run-exchange-1", big.id), big);
    assert.equal(await adapter.archive.exchange("run-exchange-1", pending.id), null, "a half-written line is not an exchange yet");
    await appendFile(path, `${pendingLine.slice(40)}\n`, "utf8");
    assert.deepEqual(await adapter.archive.exchange("run-exchange-1", pending.id), pending);

    // A second K6RunArchive (standing in for a fresh backend process) resolves the run by its
    // manifest.json and indexes the same file from scratch.
    const reopenedProcess = new K6RunArchive(join(scratch, "k6-logs"));
    assert.deepEqual(await reopenedProcess.exchange("run-exchange-1", big.id), big);
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
