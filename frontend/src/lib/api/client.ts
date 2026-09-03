import type {
  ConnectionInput,
  ConnectionTestResult,
  RunAnalysis,
  ServerConnection,
} from "@kaigara/shared-types";
import type { RunsClient } from "./runsClient";
import type { ScenariosClient } from "./scenariosClient";

/**
 * The seam between UI and data. Every screen reads through this interface, never through the
 * mock data modules directly, so a real backend-backed implementation (calling the Fastify API
 * in `backend/`, once it exists) can be substituted by passing a different client into
 * `<ApiProvider client={...}>` — see `context.tsx` — without touching any feature code.
 */
export interface ApiClient {
  connections: {
    list(): Promise<ServerConnection[]>;
    create(input: ConnectionInput): Promise<ServerConnection>;
    update(id: string, input: ConnectionInput): Promise<ServerConnection>;
    remove(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    /** Probes the target server over the standardised REST API and records the result on the
     *  connection. Unlike the rest of this interface, this is *not* mocked by default — see
     *  `connectionsClient.ts`. */
    test(id: string): Promise<ConnectionTestResult>;
  };
  /** **Real, not mocked** in the default client: the library is a folder of serialized scenario
   *  documents the orchestrator serves. See `scenariosClient.ts`. */
  scenarios: ScenariosClient;
  /** **Real, not mocked** in the default client: `start()` posts the composed timeline to the
   *  orchestrator, which compiles it into an engine script and executes it. See `runsClient.ts`. */
  runs: RunsClient;
  analysis: {
    get(runId: string): Promise<RunAnalysis>;
  };
}
