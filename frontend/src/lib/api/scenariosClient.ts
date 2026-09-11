import {
  Scenario,
  type ScenarioData,
  type ScenarioLibraryView,
  type ValidationIssue,
} from "@kaigara/shared-types";
import { ApiRequestError, readJsonOrThrow } from "./httpError";

/**
 * The real, backend-backed `scenarios` slice: the Load screen's library is a folder of serialized
 * scenario documents on the orchestrator's disk (`backend/scenarios/`, or `KAIGARA_SCENARIOS_DIR`),
 * listed by `GET /api/scenarios` and opened by `GET /api/scenarios/:id`.
 *
 * The documents that come back are the same shape the drop zone accepts and the Compose Code view
 * shows, parsed by the same `@kaigara/shared-types` reader — a library scenario and a hand-dropped
 * file are not two kinds of thing.
 *
 * Like the connection probe, this works during frontend-only development: the Vite dev server
 * mounts the backend's library module in-process (`frontend/vite.config.ts`).
 */

const SCENARIOS_ENDPOINT = "/api/scenarios";

/** Thrown when the library cannot serve a scenario. Carries the validator's per-path issues for a
 *  file that is present but unusable, so the Load screen can name the offending value. */
export class ScenarioRequestError extends ApiRequestError {}

const scenarioFailure = (message: string, status: number, issues: ValidationIssue[]) =>
  new ScenarioRequestError(message, status, issues);

export interface ScenariosClient {
  /** Every document in the library folder, including the ones that failed to load — those carry
   *  `issues` and cannot be opened. */
  library(): Promise<ScenarioLibraryView>;
  instantiate(id: string): Promise<Scenario>;
}

export function createScenariosClient(): ScenariosClient {
  const get = (path: string) => fetch(path, { headers: { accept: "application/json" } });
  const read = <T,>(response: Response) => readJsonOrThrow<T, ScenarioRequestError>(response, scenarioFailure);

  return {
    async library() {
      return read<ScenarioLibraryView>(await get(SCENARIOS_ENDPOINT));
    },

    async instantiate(id) {
      const data = await read<ScenarioData>(await get(`${SCENARIOS_ENDPOINT}/${encodeURIComponent(id)}`));
      // The backend already validated the document; rebuilding the class instances here is what
      // turns it back into something the Compose store can mutate.
      return Scenario.fromJSON(data);
    },
  };
}
