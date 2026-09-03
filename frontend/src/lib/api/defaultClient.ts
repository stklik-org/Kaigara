import type { ApiClient } from "./client";
import { createMockApiClient } from "./mockClient";
import { createConnectionsClient } from "./connectionsClient";
import { createRunsClient } from "./runsClient";
import { createScenariosClient } from "./scenariosClient";

/**
 * The client the app runs on. Only analysis is still mock data; connections, scenarios and runs
 * are real — `connections.test()` reaches an actual AAS server through the backend probe,
 * `scenarios` reads the orchestrator's scenario-library folder, and `runs.start()` posts the
 * composed timeline to the orchestrator, which compiles it into an engine script and executes it
 * against the target.
 *
 * As more of `backend/` lands, slices move from `createMockApiClient()` to real implementations
 * here, one at a time, without touching feature code.
 */
export function createDefaultApiClient(): ApiClient {
  return {
    ...createMockApiClient(),
    connections: createConnectionsClient(),
    scenarios: createScenariosClient(),
    runs: createRunsClient(),
  };
}
