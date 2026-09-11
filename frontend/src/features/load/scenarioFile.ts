import { ScenarioFileError, parseScenarioDocument, type Scenario } from "@kaigara/shared-types";

/** Reading a scenario the user picked in the browser. The *parsing* deliberately lives in
 *  `@kaigara/shared-types` — the backend's scenario-library folder reads the same documents with
 *  the same reader, so a file one accepts is a file the other accepts. Only the browser-specific
 *  parts (the size ceiling, `File` handling, byte formatting) belong here. */

/** Ceiling on what the picker/drop zone will even attempt to read. A scenario is a small
 *  declarative document (tracks/loads/request specs) — anything this large is a mis-drop, and
 *  reading it would mean blocking on a multi-megabyte JSON.parse for nothing. */
export const MAX_SCENARIO_FILE_BYTES = 5 * 1024 * 1024;

export async function readScenarioFile(file: File): Promise<Scenario> {
  if (file.size > MAX_SCENARIO_FILE_BYTES) {
    throw new ScenarioFileError(
      `${file.name} is ${formatBytes(file.size)} — larger than the ${formatBytes(MAX_SCENARIO_FILE_BYTES)} limit for a scenario file.`,
    );
  }
  return parseScenarioDocument(await file.text(), file.name);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
