import {
  Scenario,
  type ScenarioData,
  type ScenarioLibraryEntry,
  type ScenarioLibraryView,
  type ValidationIssue,
} from "@kaigara/shared-types";

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
export class ScenarioRequestError extends Error {
  readonly issues: ValidationIssue[];
  readonly status: number;

  constructor(message: string, status: number, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ScenarioRequestError";
    this.status = status;
    this.issues = issues;
  }
}

async function failure(response: Response): Promise<ScenarioRequestError> {
  let message = `${response.status} ${response.statusText}`;
  let issues: ValidationIssue[] = [];
  try {
    const body = await response.json();
    if (typeof body?.error === "string") message = body.error;
    if (Array.isArray(body?.issues)) issues = body.issues;
  } catch {
    // A non-JSON error body (a proxy's HTML 502, say) leaves the status line as the message.
  }
  return new ScenarioRequestError(message, response.status, issues);
}

export interface ScenariosClient {
  /** Every document in the library folder, including the ones that failed to load — those carry
   *  `issues` and cannot be opened. */
  library(): Promise<ScenarioLibraryView>;
  /** The listing the rest of the app reads: loadable entries only. */
  templates(): Promise<ScenarioLibraryEntry[]>;
  instantiate(id: string): Promise<Scenario>;
}

export function createScenariosClient(): ScenariosClient {
  async function library(): Promise<ScenarioLibraryView> {
    const response = await fetch(SCENARIOS_ENDPOINT, { headers: { accept: "application/json" } });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as ScenarioLibraryView;
  }

  return {
    library,
    async templates() {
      const view = await library();
      return view.entries.filter((entry) => entry.issues === undefined || entry.issues.length === 0);
    },
    async instantiate(id) {
      const response = await fetch(`${SCENARIOS_ENDPOINT}/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw await failure(response);
      // The backend already validated the document; rebuilding the class instances here is what
      // turns it back into something the Compose store can mutate.
      return Scenario.fromJSON((await response.json()) as ScenarioData);
    },
  };
}
