/**
 * A persistent, human-navigable archive of every set of k6 scripts this process generates and every
 * k6 invocation it makes — so a benchmark can be reproduced by hand later, long after the run's
 * working directory under the OS tmpdir has been swept away, and so a *previous* run can be
 * reopened on the Run screen (`GET /api/runs/archive`) even from a backend process that has since
 * restarted, losing the in-memory `RunRecord` entirely.
 *
 * Layout, one session folder per backend process (created lazily on the first run), one folder per
 * run inside it holding exactly the files k6 was handed (ADR 0005), plus what "open previous
 * execution" needs to reconstruct the Run screen's view of it:
 *
 *   <KAIGARA_LOG_DIR>/                           (default: <cwd>/k6-logs)
 *     2026-09-11_143002/                         session — the backend's start time
 *       ExecutionPlan.txt                        one block per run: when k6 was called, the exact
 *                                                command line, a copy-pasteable line that re-runs it,
 *                                                and when each script starts on the timeline
 *       20260911-143045_minimal-crud_a1b2c3d4/   one run
 *         main.js                                the entry point — schedules the scripts below
 *         k6_writes_steady_create_submodel.js    one standalone script per request type of a load,
 *                                                named k6_<track>_<load>_<request spec>
 *         …
 *         plan.json                              the k6 plan they were rendered from
 *         timeline.json                          the *authored* LoadTimeline the plan was compiled
 *                                                from — reopening a previous run restores this
 *         manifest.json                          scenario name, target, timing and final totals —
 *                                                written at compile time, filled in as the run
 *                                                progresses, so `GET /api/runs/archive` never has
 *                                                to parse every run's metrics just to list them
 *         metrics.ndjson                         k6's own `--out json=` stream, copied here once
 *                                                the run exits — re-parsed with the same
 *                                                `K6OutputParser` a live run uses, on demand, only
 *                                                when a previous run is actually opened
 *         exchanges.log                          one captured request/response pair per line, as
 *                                                much of each body as the timeline's `capture`
 *                                                setting keeps — written by k6 itself while the run
 *                                                is live (`--console-output`), read back one line at
 *                                                a time by the Run screen's popup (exchangeLog.ts)
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

import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { LoadTimelineData, RunArchiveDetail, RunArchiveEntry, RunArchiveManifest, RunExchange, RunPlanSummary } from "@kaigara/shared-types";

import type { RequestSample } from "../adapter.ts";
import type { GeneratedFile } from "./compileTimeline.ts";
import { describeExecutor, planScripts, redactPlan, secondsToK6Duration, REDACTED, type K6Plan } from "./k6Plan.ts";
import { K6OutputParser } from "./parseOutput.ts";
import { EXCHANGES_FILE, ExchangeLogIndex } from "./exchangeLog.ts";
import { HEADERS_ENV, requestLine } from "./scriptTemplates.ts";

/** Turns a `{session, folder}` location into the opaque id `GET /api/runs/archive/:id` takes —
 *  base64url so it survives being a single URL path segment despite containing a `/`. */
function encodeArchiveId(location: RunLocation): string {
  return Buffer.from(`${location.session}/${location.folder}`, "utf8").toString("base64url");
}

/** The inverse of `encodeArchiveId`, rejecting anything that does not decode to exactly two
 *  non-empty, traversal-free segments — the same discipline `scenarios/library.ts` applies to a
 *  scenario id, for the same reason: this ends up in a filesystem path. */
function decodeArchiveId(id: string): RunLocation | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("/");
  if (parts.length !== 2) return null;
  const [session, folder] = parts;
  if (!session || !folder || session.includes("..") || folder.includes("..")) return null;
  return { session, folder };
}

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

/** The same projection `RunService`'s `view()` builds for a live run's `RunView.plan` — read here
 *  from the archived (redacted) `plan.json` instead, so a reopened run's request log resolves
 *  `loadKey`s to human labels exactly the way a live one does. */
function planSummaryFrom(plan: K6Plan): RunPlanSummary {
  return {
    totalDurationSeconds: plan.totalDurationSeconds,
    loadCount: plan.loads.length,
    expectedRequests: plan.expectedRequests,
    loads: plan.loads.map((load) => ({
      key: load.key,
      loadId: load.loadId,
      trackId: load.trackId,
      label: load.label,
      startSeconds: load.startSeconds,
      requestCount: load.scripts.length,
    })),
  };
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
  /** k6's `--console-output` target in `argv` — likewise made local in the reproduce line. */
  exchangesPath: string;
  /** Names of the target headers handed to k6 through `KAIGARA_HEADERS`; values are never logged. */
  headerNames: string[];
  /** `Date.now()` at the moment k6 was actually spawned — what `K6OutputParser` needs to turn the
   *  archived `metrics.ndjson`'s absolute timestamps back into the same offsets a live run shows. */
  startEpochMs: number;
}

/** `manifest.json` — the wire shape is `RunArchiveManifest`/`RunArchiveEntry`/`RunArchiveDetail`
 *  in `@kaigara/shared-types`, reused here rather than re-declared so the archive file's own shape
 *  and what the route hands back can never drift apart. Written in three passes (compile,
 *  invocation, exit) as each fact becomes known; a run that never got past compiling has only the
 *  first pass's fields. */
type ArchiveManifest = RunArchiveManifest;
type ArchiveListEntry = RunArchiveEntry;
type ArchivedRun = RunArchiveDetail;

/** One archived run's compile-time facts, remembered until its invocation is logged. */
interface PendingRun {
  folder: string;
  artifacts: string[];
  hasRandomizedBody: boolean;
}

/** Where one run's folder lives, kept for the run's whole lifetime (compile through exit) — longer
 *  than `pending`, which is only the short-lived compile-to-invocation handoff. */
interface RunLocation {
  session: string;
  folder: string;
}

export class K6RunArchive {
  private readonly baseDir: string;
  private readonly sessionDirName: string;
  private sessionDir: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRun>();
  private readonly runFolders = new Map<string, RunLocation>();
  /** One index per run whose exchanges someone has asked for — built lazily, by runId. */
  private readonly exchangeIndexes = new Map<string, ExchangeLogIndex>();

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
   * Saves one run's generated files — `main.js` and every script — plus its plan, the *authored*
   * timeline it was compiled from, an initial `manifest.json`, and any payloads fixed at compile
   * time (Exact bodies, Mutate bases) into the run's own folder. Called from the adapter's
   * `compile()`.
   */
  async saveScripts(runId: string, plan: K6Plan, files: GeneratedFile[], timeline: LoadTimelineData, now: Date = new Date()): Promise<void> {
    try {
      const session = await this.ready();
      const folder = `${runStamp(now)}_${slug(plan.scenarioName)}_${runId.slice(0, 8)}`;
      const dir = join(session, folder);
      await mkdir(join(dir, "artifacts"), { recursive: true });

      for (const file of files) await writeFile(join(dir, file.name), file.content, "utf8");
      await writeFile(join(dir, "plan.json"), `${JSON.stringify(redactPlan(plan), null, 2)}\n`, "utf8");
      await writeFile(join(dir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");

      const manifest: ArchiveManifest = {
        runId,
        scenarioName: plan.scenarioName,
        targetBaseUrl: plan.target.baseUrl,
        engineId: "k6",
        calledAt: now.toISOString(),
      };
      await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      // Bare session *name*, not the absolute `session` above — `RunLocation` is also what
      // `encodeArchiveId`/`list()`/`read()` use, and those need something stable to rejoin against
      // `this.baseDir` from a fresh directory scan, not a path baked in at this moment.
      this.runFolders.set(runId, { session: this.sessionDirName, folder });

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
      await this.mergeManifest(runId, { calledAt: now.toISOString(), startEpochMs: invocation.startEpochMs });

      const command = [headersEnv(invocation.headerNames, REDACTED), invocation.binary, ...invocation.argv].map((part, index) =>
        index === 0 ? part : shquote(part),
      );
      // The reproduce line is meant to be pasted as-is: it `cd`s into the run's archived folder, so
      // the entry point and the --out target — both under the now-gone tmp work dir — become local.
      const reproduceArgv = invocation.argv.map((arg) => {
        if (arg === `json=${invocation.metricsPath}`) return "json=./metrics.ndjson";
        if (arg === invocation.exchangesPath) return `./${EXCHANGES_FILE}`;
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

  /** Merges `patch` into `manifest.json` for a run this archive still knows the folder for — a
   *  no-op if it does not (compile never got far enough to call `saveScripts`, say). Not wrapped in
   *  its own try/catch: every caller already has one. */
  private async mergeManifest(runId: string, patch: Partial<ArchiveManifest>): Promise<void> {
    const location = this.runFolders.get(runId);
    if (!location) return;
    const manifestPath = join(this.baseDir, location.session, location.folder, "manifest.json");
    const existing = JSON.parse(await readFile(manifestPath, "utf8")) as ArchiveManifest;
    await writeFile(manifestPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
  }

  /**
   * Called once, when the run reaches a terminal status (`RunService.finish()`, via the adapter):
   * folds the final status/totals into `manifest.json` and copies k6's own metrics stream into the
   * archive, so `GET /api/runs/archive/:id` can re-parse it long after `metricsPath` (under the OS
   * tmpdir) is gone. Drops this run from the archive's own bookkeeping either way — a second call
   * for the same run id would find nothing to finalize.
   */
  async finalizeRun(
    runId: string,
    result: { status: string; endedAt: string; requests: number; failed: number },
    metricsPath: string,
  ): Promise<void> {
    const location = this.runFolders.get(runId);
    try {
      if (!location) return;
      const dir = join(this.baseDir, location.session, location.folder);
      await this.mergeManifest(runId, result);
      await copyFile(metricsPath, join(dir, "metrics.ndjson"));
    } catch (error) {
      console.warn(`k6 run archive: could not finalize run ${runId}: ${(error as Error).message}`);
    }
    // `runFolders` is deliberately kept — `exchange()` and a same-process "reopen right after it
    // finished" still need to resolve this runId to a folder without an archive id. Same "not
    // evicted today" tradeoff RunService's own in-memory run map already makes.
  }

  /** Where k6 should write this run's exchanges — `undefined` if the run's scripts were never
   *  archived (a failed `saveScripts`), in which case no popup will find them. */
  exchangesPath(runId: string): string | undefined {
    const location = this.runFolders.get(runId);
    return location ? join(this.baseDir, location.session, location.folder, EXCHANGES_FILE) : undefined;
  }

  /** Resolves a bare runId to its archive folder — the in-memory map first (the fast path for a
   *  run this process itself compiled), falling back to a directory scan matching each
   *  `manifest.json`'s own `runId` field otherwise, so a run archived by an *earlier* backend
   *  process (exactly the case "open previous execution" exists for) still resolves — its result
   *  is cached back into the map so a second lookup for the same run does not re-scan. `null` if
   *  no manifest anywhere claims this runId. */
  private async resolveRunLocation(runId: string): Promise<RunLocation | null> {
    const cached = this.runFolders.get(runId);
    if (cached) return cached;

    try {
      const sessions = await readdir(this.baseDir, { withFileTypes: true });
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const runFolders = await readdir(join(this.baseDir, session.name), { withFileTypes: true }).catch(() => []);
        for (const runFolder of runFolders) {
          if (!runFolder.isDirectory()) continue;
          const location: RunLocation = { session: session.name, folder: runFolder.name };
          try {
            const manifest = JSON.parse(
              await readFile(join(this.baseDir, location.session, location.folder, "manifest.json"), "utf8"),
            ) as ArchiveManifest;
            if (manifest.runId === runId) {
              this.runFolders.set(runId, location);
              return location;
            }
          } catch {
            // No manifest, or an unparseable one — not this lookup's business to repair.
          }
        }
      }
    } catch {
      // No archive directory at all yet.
    }
    return null;
  }

  /**
   * One captured exchange for the Run screen's "open this row" popup, by runId (not an archive
   * id — this also serves a run that is still live, whose `exchanges.log` k6 is still appending
   * to). `null` if the run's log has no such line: this runId is not one the archive knows, or the
   * run predates `exchanges.log`.
   */
  async exchange(runId: string, exchangeId: string): Promise<RunExchange | null> {
    let index = this.exchangeIndexes.get(runId);
    if (!index) {
      const location = await this.resolveRunLocation(runId);
      if (!location) return null;
      index = new ExchangeLogIndex(join(this.baseDir, location.session, location.folder, EXCHANGES_FILE));
      this.exchangeIndexes.set(runId, index);
    }
    return index.find(exchangeId);
  }

  /**
   * Every run this archive (across every session this `baseDir` has ever seen — a backend
   * restart does not lose "open previous execution", only the in-memory `RunRecord`) has a
   * `manifest.json` for, newest first. A run whose manifest is missing or unreadable is skipped
   * rather than shown broken — an archive folder from before this feature existed has no manifest
   * at all.
   */
  async list(): Promise<ArchiveListEntry[]> {
    const entries: ArchiveListEntry[] = [];
    try {
      const sessions = await readdir(this.baseDir, { withFileTypes: true });
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const runFolders = await readdir(join(this.baseDir, session.name), { withFileTypes: true }).catch(() => []);
        for (const runFolder of runFolders) {
          if (!runFolder.isDirectory()) continue;
          const location: RunLocation = { session: session.name, folder: runFolder.name };
          try {
            const manifest = JSON.parse(
              await readFile(join(this.baseDir, location.session, location.folder, "manifest.json"), "utf8"),
            ) as ArchiveManifest;
            entries.push({ ...manifest, id: encodeArchiveId(location) });
          } catch {
            // No manifest, or an unparseable one — not this feature's business to repair.
          }
        }
      }
    } catch (error) {
      console.warn(`k6 run archive: could not list archived runs: ${(error as Error).message}`);
    }
    return entries.sort((a, b) => b.calledAt.localeCompare(a.calledAt));
  }

  /**
   * Reconstructs one archived run for `GET /api/runs/archive/:id` — its manifest always, its
   * authored timeline and per-request log whenever their files are present. Returns `null` for an
   * id that does not decode, does not exist, or (defensively) resolves outside `baseDir`.
   */
  async read(id: string): Promise<ArchivedRun | null> {
    const location = decodeArchiveId(id);
    if (!location) return null;

    const dir = join(this.baseDir, location.session, location.folder);
    const resolvedBase = resolve(this.baseDir) + sep;
    if (!resolve(dir).startsWith(resolvedBase)) return null;

    let manifest: ArchiveManifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ArchiveManifest;
    } catch {
      return null;
    }
    // Caches the runId -> folder mapping `exchange()` needs, so opening this run and then clicking
    // a row does not also need its own directory scan.
    this.runFolders.set(manifest.runId, location);

    const timeline = await readFile(join(dir, "timeline.json"), "utf8")
      .then((text) => JSON.parse(text) as LoadTimelineData)
      .catch(() => null);

    const plan = await readFile(join(dir, "plan.json"), "utf8")
      .then((text) => planSummaryFrom(JSON.parse(text) as K6Plan))
      .catch(() => null);

    // Never eagerly parsed here: `metrics.ndjson` can hold hundreds of thousands of samples, and
    // "reopen this run" must not by itself pay to parse and transfer all of them. The Run screen
    // fetches a Load's log lazily instead, from `requestLog()` below, exactly the way a live run's
    // `GET /api/runs/{id}/requests?loadId=` does.
    return { manifest, timeline, plan, requestLog: null };
  }

  /**
   * A Load's request log for an archived run, by its bare `runId` (not an archive id — mirrors
   * `exchange()`, so the same endpoint serves a live and an archived run alike). Re-parses
   * `metrics.ndjson` on every call rather than caching it: this is fetched once per Load selection,
   * not on any repeating cadence, so the simplicity is worth more than the saved re-parse. `null`
   * when the run is not archived, or has no `metrics.ndjson` yet (never got past compiling). Only
   * ever called for a `loadId` — omitting it returns no samples, matching `RunRequestLog`'s own
   * contract, since nothing needs the whole run's log at once any more.
   */
  async requestLog(runId: string, loadId: string | undefined): Promise<{ samples: RequestSample[]; truncated: boolean } | null> {
    const location = await this.resolveRunLocation(runId);
    if (!location) return null;
    const dir = join(this.baseDir, location.session, location.folder);

    const manifest = await readFile(join(dir, "manifest.json"), "utf8")
      .then((text) => JSON.parse(text) as ArchiveManifest)
      .catch(() => null);
    if (!manifest) return null;

    const parsed = await this.readRequestLog(dir, manifest.startEpochMs ?? 0);
    if (!parsed) return null;
    if (loadId === undefined) return { samples: [], truncated: parsed.truncated };

    const plan = await readFile(join(dir, "plan.json"), "utf8")
      .then((text) => JSON.parse(text) as K6Plan)
      .catch(() => null);
    const allowedKeys = new Set(plan?.loads.filter((load) => load.loadId === loadId).map((load) => load.key) ?? []);
    const samples = await this.enrichTruncation(runId, parsed.samples.filter((sample) => allowedKeys.has(sample.loadKey)));
    return { samples, truncated: parsed.truncated };
  }

  /** Re-parses the archived `metrics.ndjson` with the same `K6OutputParser` a live run tails —
   *  `null` when the file is missing (a run that never got past compiling, or an archive from
   *  before this feature existed). */
  private async readRequestLog(dir: string, startEpochMs: number): Promise<{ samples: RequestSample[]; truncated: boolean } | null> {
    let text: string;
    try {
      text = await readFile(join(dir, "metrics.ndjson"), "utf8");
    } catch {
      return null;
    }
    const parser = new K6OutputParser(startEpochMs);
    const first = parser.push(text);
    const rest = parser.flush();
    return { samples: [...first.samples, ...rest.samples], truncated: false };
  }

  /** Attaches `requestTruncated`/`responseTruncated` to every sample that has an `exchangeId`, from
   *  the same `exchanges.log` index `exchange()` uses (cached per runId, built lazily). Cheap: the
   *  index reads only header bytes, never a body, so this costs one index build (or reuse of an
   *  already-built one) plus a map lookup per sample. Samples with no matching exchange line — an
   *  older archive, or an engine that never captured one — are left as they are. */
  async enrichTruncation(runId: string, samples: RequestSample[]): Promise<RequestSample[]> {
    let index = this.exchangeIndexes.get(runId);
    if (!index) {
      const location = await this.resolveRunLocation(runId);
      if (!location) return samples;
      index = new ExchangeLogIndex(join(this.baseDir, location.session, location.folder, EXCHANGES_FILE));
      this.exchangeIndexes.set(runId, index);
    }
    await index.ensureScanned();
    for (const sample of samples) {
      if (!sample.exchangeId) continue;
      const truncation = index.truncationFor(sample.exchangeId);
      if (truncation) Object.assign(sample, truncation);
    }
    return samples;
  }
}
