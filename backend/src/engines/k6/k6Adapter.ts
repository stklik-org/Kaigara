/**
 * The k6 engine adapter — the only adapter implemented, per ADR 0001.
 *
 * k6 is run **as an external subprocess**, exactly as a person would from a terminal, and is never
 * linked into this process. That is a licensing constraint, not a style preference: k6 is AGPL-3.0
 * and the network-copyleft clause is triggered by linking, not by invoking a CLI (proposal
 * sections 3.1 and 12). Nothing here imports k6 code; it writes scripts, spawns a binary,
 * and reads the binary's output.
 *
 * Per ADR 0004, `compile()` takes the authored timeline straight from `EngineRunContext` and owns
 * the whole translation to k6 itself: `compileTimeline()` splits it into one small script per
 * request type of every load, decides the identifiers each addresses (harvesting the target once),
 * and renders them plus a thin `main.js` that schedules them in one k6 process (ADR 0005). The
 * `K6Plan` behind those files never leaves this file: `compile()` stashes it in `plans`, keyed by
 * run id, purely so `start()` can log a faithful `ExecutionPlan.txt` entry — the public
 * `CompiledRun` it returns carries only the thin summary `RunService` actually needs.
 *
 * Target headers (an Authorization token, typically) reach k6 only through its environment
 * (`KAIGARA_HEADERS`), never through a file: the generated scripts are written to disk, archived,
 * and served back over the API.
 *
 * Results come back through k6's `--out json` stream, which is written to a file and tailed
 * incrementally rather than piped through stdout. Two reasons: k6 interleaves its progress UI
 * with stdout, and a file gives the full-resolution record the proposal (section 7.2) wants kept
 * for later analysis while only aggregates are streamed live.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

import type { EngineId } from "@kaigara/shared-types";
import type {
  CompiledArtifact,
  CompiledRun,
  EngineAdapter,
  EngineAvailability,
  EngineHandlers,
  EngineRunContext,
  EngineRunHandle,
} from "../adapter.ts";
import { compileTimeline } from "./compileTimeline.ts";
import { planScripts, redactPlan, type K6Plan } from "./k6Plan.ts";
import { K6OutputParser, readSummaryTotals } from "./parseOutput.ts";
import { K6RunArchive } from "./runArchive.ts";
import { HEADERS_ENV, SUMMARY_FILE, requestLine } from "./scriptTemplates.ts";

/** How often the metrics file is drained. One second matches the proposal's "one point per second
 *  rather than per request" guidance for the live view (section 7.2). */
const TAIL_INTERVAL_MS = 1000;
/** Grace period between asking k6 to stop and killing it outright. */
const STOP_GRACE_MS = 5000;

export interface K6AdapterOptions {
  /** Path to the k6 binary; defaults to whatever is on PATH. */
  binary?: string;
  /** Base folder for the persistent run archive (scripts, plans, ExecutionPlan.txt, payloads).
   *  Defaults to `KAIGARA_LOG_DIR`, then `<cwd>/k6-logs`. */
  logDir?: string;
}

/** Thrown when a timeline validates but has nothing to actually run — every load either has no
 *  requests or a rate of zero. `RunService.create()` must never record a run that could not
 *  compile to this, so `compile()` throws it before writing anything. */
export class EmptyPlanError extends Error {}

export class K6Adapter implements EngineAdapter {
  readonly id: EngineId = "k6";
  readonly name = "Grafana k6";

  private readonly binary: string;
  /** Persistent, human-navigable record of every script generated and every `k6 run` issued, so a
   *  benchmark can be reproduced after its tmp work dir is gone — see `runArchive.ts`. */
  private readonly archive: K6RunArchive;
  /** The `K6Plan` `compile()` built, kept only until the matching `start()` call has logged it to
   *  the archive — see the module doc. A `dryRun` compile whose `start()` never comes leaves its
   *  entry here for the life of the process, same as the run itself staying in `RunService`'s
   *  in-memory map forever; neither is evicted today (proposal §10 is the real fix). */
  private readonly plans = new Map<string, K6Plan>();

  constructor(options: K6AdapterOptions = {}) {
    this.binary = options.binary ?? process.env.KAIGARA_K6_BINARY ?? "k6";
    this.archive = new K6RunArchive(options.logDir ?? process.env.KAIGARA_LOG_DIR ?? join(cwd(), "k6-logs"));
  }

  async probe(): Promise<EngineAvailability> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.binary, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ available: false, detail: `Could not execute "${this.binary}": ${(error as Error).message}` });
        return;
      }

      let output = "";
      child.stdout?.on("data", (chunk) => (output += String(chunk)));
      child.stderr?.on("data", (chunk) => (output += String(chunk)));

      child.on("error", (error) => {
        const hint =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `k6 was not found on PATH. Install it (e.g. "brew install k6") or set KAIGARA_K6_BINARY.`
            : error.message;
        resolve({ available: false, detail: hint });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          resolve({ available: false, detail: `"${this.binary} version" exited with code ${code}.` });
          return;
        }
        const version = output.trim().split("\n")[0] ?? "";
        resolve({ available: true, version, detail: version });
      });
    });
  }

  async compile(context: EngineRunContext): Promise<CompiledRun> {
    // Everything — validation, shape -> executor, the split per request type, which identifiers
    // each script addresses, and the files themselves — happens in compileTimeline.ts.
    const { plan, files, warnings } = await compileTimeline(context.timeline, {
      scenarioName: context.scenarioName,
      target: context.target,
    });
    const scripts = planScripts(plan);

    // A timeline whose every load has no requests (or a rate of zero) compiles to no scripts at
    // all; k6 would start, schedule nothing, and fail. Refuse before anything is written, so
    // RunService never records a run for it.
    if (scripts.length === 0) {
      throw new EmptyPlanError(
        "This timeline has nothing to execute: every load either has no requests or a rate of zero.",
      );
    }

    // main.js and the scripts it imports go side by side into the work dir, which is also where k6
    // runs — so main.js's relative imports and its relative summary.json both resolve there. The
    // plan goes alongside, redacted, so the compiled view of what was executed survives on its own.
    for (const file of files) await writeFile(join(context.workDir, file.name), file.content, "utf8");
    const planPath = join(context.workDir, "plan.json");
    await writeFile(planPath, `${JSON.stringify(redactPlan(plan), null, 2)}\n`, "utf8");

    // Also mirror everything into the persistent archive; the work dir above is under the OS tmpdir
    // and does not survive. Never throws.
    await this.archive.saveScripts(context.runId, plan, files);
    // Kept only for start()'s archive logging — see the module doc and the `plans` field comment.
    this.plans.set(context.runId, plan);

    const scriptByFile = new Map(scripts.map((script) => [script.file, script]));
    const loadLabel = new Map(plan.loads.map((load) => [load.key, load.label]));
    const artifacts: CompiledArtifact[] = [
      ...files.map((file): CompiledArtifact => {
        const script = scriptByFile.get(file.name);
        return {
          name: file.name,
          absolutePath: join(context.workDir, file.name),
          contentType: "application/javascript",
          description: script
            ? `${requestLine(script)} — ${loadLabel.get(script.loadKey)}.`
            : "Entry point handed to `k6 run`: schedules every script below as one k6 scenario.",
        };
      }),
      {
        name: "plan.json",
        absolutePath: planPath,
        contentType: "application/json",
        description: "The k6 plan the scripts were rendered from: loads, their scripts, executors and identifier lists.",
      },
    ];

    return {
      artifacts,
      warnings,
      summary: {
        scenarioName: plan.scenarioName,
        totalDurationSeconds: plan.totalDurationSeconds,
        expectedRequests: plan.expectedRequests,
        loads: plan.loads.map((load) => ({
          key: load.key,
          loadId: load.loadId,
          trackId: load.trackId,
          label: load.label,
          startSeconds: load.startSeconds,
          requestCount: load.scripts.length,
        })),
      },
    };
  }

  async start(context: EngineRunContext, compiled: CompiledRun, handlers: EngineHandlers): Promise<EngineRunHandle> {
    const entry = compiled.artifacts.find((artifact) => artifact.name === "main.js");
    if (!entry) throw new Error("k6 adapter: compile() must run before start().");

    const metricsPath = join(context.workDir, "metrics.ndjson");
    // main.js's handleSummary writes this relative to where k6 runs — the work dir, see spawn().
    const summaryPath = join(context.workDir, SUMMARY_FILE);
    const startEpochMs = Date.now();

    // `--quiet` drops the progress bar (which would otherwise dominate stdout and tell us nothing
    // we are not already reading from the metrics stream). `--no-usage-report` keeps a benchmark
    // run from making an unrelated outbound request of its own.
    const args = [
      "run",
      "--quiet",
      "--no-usage-report",
      "--out",
      `json=${metricsPath}`,
      entry.absolutePath,
    ];

    // Record when this script is being called and with exactly which command line, so the run can
    // be reproduced from the archive folder later. Never throws.
    const plan = this.plans.get(context.runId);
    this.plans.delete(context.runId);
    if (plan) {
      await this.archive.logInvocation(context.runId, plan, {
        binary: this.binary,
        argv: args,
        workDir: context.workDir,
        entryPath: entry.absolutePath,
        metricsPath,
        headerNames: Object.keys(context.target.headers),
      });
    }

    // The target's headers reach the scripts through the environment, never through a file.
    const child = spawn(this.binary, args, {
      cwd: context.workDir,
      env: { ...process.env, [HEADERS_ENV]: JSON.stringify(context.target.headers) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const parser = new K6OutputParser(startEpochMs);
    let droppedIterations = 0;
    let skippedNoId = 0;
    let offset = 0;
    let stopped = false;
    let exited = false;

    const drain = async (): Promise<void> => {
      // k6 creates the metrics file shortly after start; until then there is simply nothing to do.
      let handle;
      try {
        handle = await open(metricsPath, "r");
      } catch {
        return;
      }
      try {
        const { size } = await handle.stat();
        if (size <= offset) return;

        const chunks: Buffer[] = [];
        const stream = createReadStream("", { fd: handle.fd, start: offset, end: size - 1, autoClose: false });
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (chunk) => chunks.push(chunk as Buffer));
          stream.on("end", () => resolve());
          stream.on("error", reject);
        });
        offset = size;

        const batch = parser.push(Buffer.concat(chunks).toString("utf8"));
        droppedIterations += batch.droppedIterations;
        skippedNoId += batch.skippedNoId;
        if (batch.samples.length > 0) handlers.onSamples(batch.samples);
      } finally {
        await handle.close();
      }
    };

    // Drains are queued behind one another rather than fired concurrently: each one advances
    // `offset` only after it has read, so two overlapping reads — the interval's and the final one
    // on close — would read the same bytes twice and report every one of those requests twice.
    let queue: Promise<void> = Promise.resolve();
    const drainOnce = (): Promise<void> => {
      queue = queue.then(drain).catch((error) => {
        handlers.onLog({ stream: "stderr", message: `metrics tail failed: ${(error as Error).message}` });
      });
      return queue;
    };

    const timer = setInterval(() => void drainOnce(), TAIL_INTERVAL_MS);

    child.stdout?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") handlers.onLog({ stream: "stdout", message: line });
      }
    });
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") handlers.onLog({ stream: "stderr", message: line });
      }
    });

    child.on("error", (error) => {
      handlers.onLog({ stream: "stderr", message: `k6 failed to start: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      exited = true;
      clearInterval(timer);

      void (async () => {
        // One last drain: the interval may have missed everything written since its last tick. It
        // queues behind any drain still in flight, so nothing is read — and counted — twice.
        await drainOnce();
        const tail = parser.flush();
        droppedIterations += tail.droppedIterations;
        skippedNoId += tail.skippedNoId;
        if (tail.samples.length > 0) handlers.onSamples(tail.samples);

        let summary;
        try {
          summary = readSummaryTotals(JSON.parse(await readFile(summaryPath, "utf8"))) ?? undefined;
        } catch {
          summary = undefined;
        }

        handlers.onExit({
          code,
          signal,
          // k6 exits non-zero when a threshold fails, which is a completed run with a verdict, not
          // a crash. Treating any non-zero code as failure would misreport those, so completion is
          // decided here: the run completed unless it was stopped or never produced a summary.
          completed: !stopped && summary !== undefined,
          summary: summary
            ? {
                requests: summary.requests,
                failed: summary.failed,
                durationMs: summary.durationMs,
                droppedIterations: summary.droppedIterations ?? droppedIterations,
              }
            : { requests: 0, failed: 0, droppedIterations },
        });

        if (skippedNoId > 0) {
          handlers.onLog({
            stream: "stderr",
            message: `${skippedNoId} request(s) were skipped: their script had no identifier left to address (see the compile warnings). Seed the target, or create the entities earlier in the timeline.`,
          });
        }
      })();
    });

    return {
      stop: async () => {
        if (exited) return;
        stopped = true;
        // SIGINT is k6's documented graceful stop: it finishes in-flight iterations and still runs
        // handleSummary, so a stopped run keeps the results it had earned.
        child.kill("SIGINT");
        await new Promise<void>((resolve) => {
          const forceTimer = setTimeout(() => {
            if (!exited) child.kill("SIGKILL");
            resolve();
          }, STOP_GRACE_MS);
          child.once("close", () => {
            clearTimeout(forceTimer);
            resolve();
          });
        });
      },
    };
  }
}
