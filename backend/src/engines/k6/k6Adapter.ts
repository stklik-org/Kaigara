/**
 * The k6 engine adapter — the only adapter implemented, per ADR 0001.
 *
 * k6 is run **as an external subprocess**, exactly as a person would from a terminal, and is never
 * linked into this process. That is a licensing constraint, not a style preference: k6 is AGPL-3.0
 * and the network-copyleft clause is triggered by linking, not by invoking a CLI (proposal
 * sections 3.1 and 12). Nothing here imports k6 code; it writes a script, spawns a binary, and
 * reads the binary's output.
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

import type { EngineId } from "@kaigara/shared-types";
import type {
  CompiledArtifact,
  EngineAdapter,
  EngineAvailability,
  EngineHandlers,
  EngineRunContext,
  EngineRunHandle,
} from "../adapter.ts";
import { compileK6Script } from "./compileScript.ts";
import { K6OutputParser, readSummaryTotals } from "./parseOutput.ts";

/** How often the metrics file is drained. One second matches the proposal's "one point per second
 *  rather than per request" guidance for the live view (section 7.2). */
const TAIL_INTERVAL_MS = 1000;
/** Grace period between asking k6 to stop and killing it outright. */
const STOP_GRACE_MS = 5000;

export interface K6AdapterOptions {
  /** Path to the k6 binary; defaults to whatever is on PATH. */
  binary?: string;
  assumedLatencySeconds?: number;
}

export class K6Adapter implements EngineAdapter {
  readonly id: EngineId = "k6";
  readonly name = "Grafana k6";

  private readonly binary: string;
  private readonly assumedLatencySeconds: number | undefined;

  constructor(options: K6AdapterOptions = {}) {
    this.binary = options.binary ?? process.env.KAIGARA_K6_BINARY ?? "k6";
    this.assumedLatencySeconds = options.assumedLatencySeconds;
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

  async compile(context: EngineRunContext): Promise<CompiledArtifact[]> {
    const scriptPath = join(context.workDir, "script.js");
    const planPath = join(context.workDir, "plan.json");

    const script = compileK6Script(context.plan, {
      summaryPath: join(context.workDir, "summary.json"),
      assumedLatencySeconds: this.assumedLatencySeconds,
    });

    await writeFile(scriptPath, script, "utf8");
    // The plan is written alongside the script so a run is reproducible from its own directory,
    // and so the engine-neutral view of what was executed survives independently of k6.
    await writeFile(planPath, `${JSON.stringify(context.plan, null, 2)}\n`, "utf8");

    return [
      {
        name: "script.js",
        absolutePath: scriptPath,
        contentType: "application/javascript",
        description: "Generated k6 script — every IDTA-01002 request this run will issue.",
      },
      {
        name: "plan.json",
        absolutePath: planPath,
        contentType: "application/json",
        description: "Engine-neutral execution plan the script was rendered from.",
      },
    ];
  }

  async start(
    context: EngineRunContext,
    artifacts: CompiledArtifact[],
    handlers: EngineHandlers,
  ): Promise<EngineRunHandle> {
    const script = artifacts.find((artifact) => artifact.name === "script.js");
    if (!script) throw new Error("k6 adapter: compile() must run before start().");

    const metricsPath = join(context.workDir, "metrics.ndjson");
    const summaryPath = join(context.workDir, "summary.json");
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
      script.absolutePath,
    ];

    const child = spawn(this.binary, args, { cwd: context.workDir, stdio: ["ignore", "pipe", "pipe"] });

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

    const timer = setInterval(() => {
      void drain().catch((error) => {
        handlers.onLog({ stream: "stderr", message: `metrics tail failed: ${(error as Error).message}` });
      });
    }, TAIL_INTERVAL_MS);

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
        // One last drain: the interval may have missed everything written since its last tick.
        try {
          await drain();
        } catch {
          /* the exit result matters more than the final few samples */
        }
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
            message: `${skippedNoId} request(s) were skipped: no identifier was available to update or delete. Seed the target, or add a create operation to the same load.`,
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
