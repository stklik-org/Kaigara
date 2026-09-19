import type {
  ConnectionInput,
  ConnectionTestResult,
  RunAnalysis,
  ServerConnection,
} from "@kaigara/shared-types";
import type { RunsClient } from "./runsClient";
import type { ScenariosClient } from "./scenariosClient";

/**
 * The seam between UI and data. Every screen reads through this interface — never through a data
 * module directly — so a slice can move from mock to backend-backed by passing a different client
 * into `<ApiProvider client={…}>`, without touching any feature code.
 *
 * Only `analysis` is still mock data; see `defaultClient.ts` for what the app actually runs on.
 */
export interface ApiClient {
  connections: ConnectionsClient;
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

export interface ConnectionsClient {
  list(): Promise<ServerConnection[]>;
  create(input: ConnectionInput): Promise<ServerConnection>;
  update(id: string, input: ConnectionInput): Promise<ServerConnection>;
  remove(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  /** Probes the target server over the standardised REST API and records the result on the
   *  connection. Unlike the rest of this interface, this is *not* mocked by default — see
   *  `connectionsClient.ts`. */
  test(id: string): Promise<ConnectionTestResult>;
  /** Discards every connection this browser has stored (`localStorage`, including anything the
   *  user added or edited) and reseeds the shipped demo list from `lib/mock/connections.ts`. The
   *  escape hatch for a stale list that predates a source change, or just wanting a clean slate. */
  resetToDemoDefaults(): Promise<ServerConnection[]>;
}
