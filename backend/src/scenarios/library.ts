/**
 * The scenario library: a folder of serialized scenario documents, served as-is.
 *
 * Recipes are data, not code (proposal §4.2), so the library is a directory the user can drop a
 * file into — not a table compiled into the binary. `backend/scenarios/` ships the demo set;
 * `KAIGARA_SCENARIOS_DIR` points at any other folder.
 *
 * Deliberately free of Fastify, exactly like `connections/probe.ts`: the Vite dev server mounts
 * these same functions in-process so `npm run dev -w frontend` alone shows a populated Load
 * screen (see `frontend/vite.config.ts`).
 *
 * Every file is read through `parseScenarioDocument` from `@kaigara/shared-types` — the same
 * parser the Load screen's drop zone uses — so a file this folder serves is exactly a file a user
 * could have dropped in by hand, and a file it rejects is rejected for a reason the user can read.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ScenarioFileError,
  parseScenarioDocument,
  type ScenarioData,
  type ScenarioLibraryEntry,
  type ScenarioLibraryView,
} from "@kaigara/shared-types";

/** Shipped demo scenarios, resolved relative to this file so it does not matter what the process
 *  working directory is. */
const BUNDLED_DIR = resolve(fileURLToPath(new URL("../../scenarios", import.meta.url)));

/** A scenario id is a file stem, and it arrives from a URL path segment — so it must be unable to
 *  name anything outside the library folder. Rejecting the character class outright is clearer
 *  than normalising a traversal attempt into something harmless. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Guards against reading a whole directory of unrelated JSON when the folder is misconfigured. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class ScenarioNotFoundError extends Error {
  constructor(id: string) {
    super(`No scenario "${id}" in the library.`);
    this.name = "ScenarioNotFoundError";
  }
}

export function scenarioLibraryDir(): string {
  const configured = process.env.KAIGARA_SCENARIOS_DIR;
  if (configured === undefined || configured.trim() === "") return BUNDLED_DIR;
  return isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
}

/**
 * Lists every `.json` file in the library. Files that fail to parse or validate are listed with
 * their issues rather than dropped, so the Load screen can say *why* a scenario is unusable.
 * A missing directory is an empty library, not an error — the folder is user-owned.
 */
export async function listScenarios(directory = scenarioLibraryDir()): Promise<ScenarioLibraryView> {
  let filenames: string[];
  try {
    filenames = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directory, entries: [] };
    throw error;
  }
  filenames.sort();

  const entries = await Promise.all(filenames.map((filename) => describeFile(directory, filename)));
  return { directory, entries };
}

/** Reads one scenario by id (its file stem). Throws `ScenarioNotFoundError` when there is no such
 *  file, and `ScenarioFileError` when there is one but it is not a usable scenario. */
export async function readScenario(id: string, directory = scenarioLibraryDir()): Promise<ScenarioData> {
  if (!SAFE_ID.test(id)) throw new ScenarioNotFoundError(id);

  const filename = `${id}.json`;
  const path = join(directory, filename);
  // Belt and braces: `SAFE_ID` already excludes separators and `..`, but the file that is opened
  // must demonstrably sit directly in the library folder.
  if (resolve(dirname(path)) !== resolve(directory) || basename(path) !== filename) {
    throw new ScenarioNotFoundError(id);
  }

  const text = await readText(path, id);
  // The scenario keeps whatever id its document declares; the filename is only the fallback.
  return parseScenarioDocument(text, filename).toJSON();
}

async function describeFile(directory: string, filename: string): Promise<ScenarioLibraryEntry> {
  const id = filename.replace(/\.json$/i, "");
  try {
    const scenario = parseScenarioDocument(await readText(join(directory, filename), id), filename);
    return {
      id,
      name: scenario.name,
      description: scenario.description ?? describeShape(scenario.phases.method.tracks.length, scenario.phases.method.totalDurationSeconds),
      file: filename,
    };
  } catch (error) {
    const issues =
      error instanceof ScenarioFileError && error.issues.length > 0
        ? error.issues.filter((issue) => issue.severity === "error")
        : [{ path: "", message: (error as Error).message, severity: "error" as const }];
    return { id, name: id, description: (error as Error).message, file: filename, issues };
  }
}

/** Fallback one-liner for a document that carries no `description` of its own. */
function describeShape(trackCount: number, totalDurationSeconds: number): string {
  const tracks = `${trackCount} track${trackCount === 1 ? "" : "s"}`;
  return `${tracks} · ${Math.round(totalDurationSeconds)}s`;
}

async function readText(path: string, id: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ScenarioNotFoundError(id);
    throw error;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new ScenarioFileError(`${basename(path)} is larger than the ${MAX_FILE_BYTES} byte limit for a scenario file.`);
  }
  return text;
}
