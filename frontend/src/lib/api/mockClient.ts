import type { ConnectionTestResult } from "@kaigara/shared-types";
import type { ApiClient } from "./client";
import { createConnectionsClient, type ConnectionProbe } from "./connectionsClient";
import { mockRunAnalysis } from "../mock/analysis";

const NETWORK_DELAY_MS = 250;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), NETWORK_DELAY_MS));
}

/** Stand-in for the real reachability probe: replays whatever the seed connection declares,
 *  without sending a request. The default client uses the real one — see `defaultClient.ts`. */
const mockProbe: ConnectionProbe = async (connection) => {
  await delay(undefined);
  const reachable = connection.reachable === true;
  const result: ConnectionTestResult = {
    reachable,
    probedUrl: `${connection.baseUrl}/description`,
    probedEndpoint: "description",
    httpStatus: reachable ? 200 : undefined,
    latencyMs: reachable ? 42 : undefined,
    profiles: reachable
      ? ["https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRepositoryServiceSpecification/SSP-002"]
      : undefined,
    detail: reachable
      ? "Mocked probe — no request was sent."
      : "Mocked probe — the fixture declares this server unreachable.",
    checkedAt: new Date().toISOString(),
  };
  return result;
};

/**
 * Slices that have no honest mock.
 *
 * The scenario library is a folder on the orchestrator's disk, so a hardcoded stand-in would be a
 * *different* library from the one the app actually opens. Executing a timeline needs a real engine
 * subprocess, and faking one would put invented latency numbers in front of someone who came here
 * to measure real ones. Both fail loudly instead, naming the command that fixes it; the default
 * client replaces them with the real implementations (see `defaultClient.ts`).
 */
function requiresBackend(what: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${what} requires the Kaigara backend (npm run dev -w backend).`));
}

/** A client with no backend behind it: real connection bookkeeping against a fake probe, mock
 *  analysis data, and a loud refusal for everything that genuinely needs the orchestrator. */
export function createMockApiClient(): ApiClient {
  return {
    connections: createConnectionsClient({ probe: mockProbe, persistLocally: false }),
    scenarios: {
      library: requiresBackend("The scenario library"),
      instantiate: requiresBackend("Opening a scenario"),
    },
    runs: {
      start: requiresBackend("Starting a run"),
      stop: requiresBackend("Stopping a run"),
      detail: requiresBackend("Run detail"),
      subscribeDetail: () => () => {},
      compile: requiresBackend("Compiling a timeline"),
      concretePlan: requiresBackend("The concrete execution plan"),
      requestLog: requiresBackend("The per-request log"),
      exchange: requiresBackend("A captured request/response exchange"),
      archiveList: requiresBackend("The run archive"),
      archiveDetail: requiresBackend("Reopening an archived run"),
      engines: () => Promise.resolve([]),
    },
    analysis: {
      get: () => delay(mockRunAnalysis),
    },
  };
}
