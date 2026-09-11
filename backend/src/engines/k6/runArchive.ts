/**
 * A persistent, human-navigable archive of every set of k6 scripts this process generates and every
 * k6 invocation it makes — so a benchmark can be reproduced by hand later, long after the run's
 * working directory under the OS tmpdir has been swept away.
 *
 * Layout, one session folder per backend process (created lazily on the first run), one folder per
 * run inside it holding exactly the files k6 was handed (ADR 0005):
 *
 *   <KAIGARA_LOG_DIR>/                           (default: <cwd>/k6-logs)
 *     2026-09-11_143002/                         session — the backend's start time
 *       ExecutionPlan.txt                        one block per run: when k6 was called, the exact
 *                                                command line, a copy-pasteable line that re-runs it,
 *                                                and when each script starts on the timeline
 *       20260911-143045_minimal-crud_a1b2c3d4/   one run
 *         main.js                                the entry point — schedules the scripts below
 *         01-create-shell.js                     one standalone script per request type of a load
 *         …
 *         plan.json                              the k6 plan they were rendered from
 *         artifacts/                             request payloads fixed at compile time (Exact
 *                                                bodies, Mutate bases); always present, even empty
 *
 * Nothing written here contains a target header value: the scripts read headers from
 * `KAIGARA_HEADERS` at run time, the plan is redacted, and the logged command lines show only the
 * header *names*.
 *
 * This is k6-specific on purpose — the filenames say `.js`, the command line is `k6 run` — so it
 * lives in the k6 adapter. A second engine would keep its own archive (ADR 0002).
 *
 * Nothing here is on the critical path: every method swallows its own I/O errors (with a
 * `console.warn`) so a full disk or a read-only mount degrades the archive to "missing", never a
 * failed benchmark.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GeneratedFile } from "./compileTimeline.ts";
import { describeExecutor, planScripts, redactPlan, secondsToK6Duration, REDACTED, type K6Plan } from "./k6Plan.ts";
import { HEADERS_ENV, requestLine } from "./scriptTemplates.ts";

/** `2026-09-10_143002` — filesystem-safe, sorts chronologically, one per backend process. */
function sessionStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** `20260910-143045` — per-run, second resolution; the run id keeps it unique within a second. */
function runStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Folds a free-form name into a filename fragment. */
function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
}

/** POSIX-ish shell quoting so the logged `command` line can be pasted into a terminal as-is. */
function shquote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `KAIGARA_HEADERS='{"authorization":"<value>"}'` — the environment prefix of a logged command
 *  line, naming each header but never showing its value. */
function headersEnv(headerNames: string[], placeholder: string): string {
  const shape = Object.fromEntries(headerNames.map((name) => [name, placeholder]));
  return `${HEADERS_ENV}=${shquote(JSON.stringify(shape))}`;
}

export interface K6Invocation {
  binary: string;
  argv: string[];
  workDir: string;
  /** Absolute path of `main.js` in `argv` — rewritten to the archived copy in the reproduce line. */
  entryPath: string;
  /** k6's `--out json=` target in `argv` — redirected to a local file in the reproduce line. */
  metricsPath: string;
  /** Names of the target headers handed to k6 through `KAIGARA_HEADERS`; values are never logged. */
  headerNames: string[];
}

/** One archived run's compile-time facts, remembered until its invocation is logged. */
interface PendingRun {
  folder: string;
  artifacts: string[];
  hasRandomizedBody: boolean;
}

export class K6RunArchive {
  private readonly baseDir: string;
  private readonly sessionDirName: string;
  private sessionDir: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRun>();

  constructor(baseDir: string, now: Date = new Date()) {
    this.baseDir = baseDir;
    this.sessionDirName = sessionStamp(now);
  }

  /** The session folder, once anything has been written to it. `null` before the first run. */
  get directory(): string | null {
    return this.sessionDir;
  }

  /** Creates `<baseDir>/<session>/` on first use; idempotent. */
  private async ready(): Promise<string> {
    if (!this.readyPromise) {
      const dir = join(this.baseDir, this.sessionDirName);
      this.readyPromise = mkdir(dir, { recursive: true }).then(() => {
        this.sessionDir = dir;
      });
    }
    await this.readyPromise;
    return this.sessionDir as string;
  }

  /**
   * Saves one run's generated files — `main.js` and every script — plus its plan and any payloads
   * fixed at compile time (Exact bodies, Mutate bases) into the run's own folder. Called from the
   * adapter's `compile()`.
   */
  async saveScripts(runId: string, plan: K6Plan, files: GeneratedFile[], now: Date = new Date()): Promise<void> {
    try {
      const session = await this.ready();
      const folder = `${runStamp(now)}_${slug(plan.scenarioName)}_${runId.slice(0, 8)}`;
      const dir = join(session, folder);
      await mkdir(join(dir, "artifacts"), { recursive: true });

      for (const file of files) await writeFile(join(dir, file.name), file.content, "utf8");
      await writeFile(join(dir, "plan.json"), `${JSON.stringify(redactPlan(plan), null, 2)}\n`, "utf8");

      const artifacts: string[] = [];
      let hasRandomizedBody = false;
      for (const script of planScripts(plan)) {
        const body = script.body;
        if (body.kind === "randomized") hasRandomizedBody = true;
        if (body.kind !== "exact" && body.kind !== "mutate") continue;
        const name = `artifacts/${script.file.replace(/\.js$/, "")}.${body.kind === "mutate" ? "base" : "body"}.json`;
        await writeFile(join(dir, name), body.kind === "mutate" ? body.baseValue : body.value, "utf8");
        artifacts.push(name);
      }

      this.pending.set(runId, { folder, artifacts, hasRandomizedBody });
    } catch (error) {
      console.warn(`k6 run archive: could not save scripts for run ${runId}: ${(error as Error).message}`);
    }
  }

  /**
   * Appends the run's block to `ExecutionPlan.txt`: when k6 was called, the argv, a shell-ready
   * command line, a self-contained line that reproduces the run from its archived folder, and the
   * schedule — which script starts when. Called from the adapter's `start()`.
   */
  async logInvocation(runId: string, plan: K6Plan, invocation: K6Invocation, now: Date = new Date()): Promise<void> {
    try {
      const session = await this.ready();
      const p = this.pending.get(runId);
      this.pending.delete(runId);

      const command = [headersEnv(invocation.headerNames, REDACTED), invocation.binary, ...invocation.argv].map((part, index) =>
        index === 0 ? part : shquote(part),
      );
      // The reproduce line is meant to be pasted as-is: it `cd`s into the run's archived folder, so
      // the entry point and the --out target — both under the now-gone tmp work dir — become local.
      const reproduceArgv = invocation.argv.map((arg) => {
        if (arg === `json=${invocation.metricsPath}`) return "json=./metrics.ndjson";
        if (p && arg === invocation.entryPath) return "main.js";
        return arg;
      });
      const reproduce = p
        ? `(cd ${shquote(join(session, p.folder))} && ${headersEnv(invocation.headerNames, "…")} ${[invocation.binary, ...reproduceArgv].map(shquote).join(" ")})`
        : "(not archived — see console warnings)";

      const scripts = planScripts(plan);
      const loadByKey = new Map(plan.loads.map((load) => [load.key, load]));
      const offsets = scripts.map((script) => `+${secondsToK6Duration(script.startSeconds)}`);
      const offsetWidth = Math.max(0, ...offsets.map((offset) => offset.length));
      const fileWidth = Math.max(0, ...scripts.map((script) => script.file.length));
      const schedule = scripts.map(
        (script, index) =>
          `${offsets[index].padEnd(offsetWidth)}  ${script.file.padEnd(fileWidth)}  ${requestLine(script)} — ` +
          describeExecutor(script.executor, loadByKey.get(script.loadKey)?.shapeKind),
      );

      const lines = [
        "────────────────────────────────────────────────────────────────────────",
        `run          ${runId}`,
        `called       ${now.toISOString()}`,
        `scenario     ${plan.scenarioName}`,
        `target       ${plan.target.baseUrl}`,
        `engine       k6  (binary: ${invocation.binary})`,
        `folder       ${p ? `${p.folder}/` : "(not archived — see console warnings)"}  ·  main.js + ${scripts.length} script(s), ~${plan.expectedRequests} requests`,
        `work dir     ${invocation.workDir}`,
        `argv         ${JSON.stringify(invocation.argv)}`,
        `command      ${command.join(" ")}`,
        `reproduce    ${reproduce}`,
        `schedule     ${schedule[0] ?? "(nothing to run)"}`,
        ...schedule.slice(1).map((line) => `             ${line}`),
      ];

      if (p && p.artifacts.length > 0) {
        lines.push(`artifacts    ${p.artifacts[0]}`);
        for (const artifact of p.artifacts.slice(1)) lines.push(`             ${artifact}`);
      } else {
        lines.push("artifacts    (none fixed at compile time)");
      }
      if (p?.hasRandomizedBody) {
        lines.push("             randomized bodies are generated inside the scripts — see their bodyFor()");
      }
      lines.push("");

      await appendFile(join(session, "ExecutionPlan.txt"), lines.join("\n") + "\n", "utf8");
    } catch (error) {
      console.warn(`k6 run archive: could not log invocation for run ${runId}: ${(error as Error).message}`);
    }
  }
}
