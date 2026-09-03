import type { ConnectionTestResult } from "@kaigara/shared-types";
import type { ApiClient } from "./client";
import { createConnectionsClient, type ConnectionProbe } from "./connectionsClient";
import { mockRunState } from "../mock/runs";
import { mockRunAnalysis } from "../mock/analysis";

const NETWORK_DELAY_MS = 250;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), NETWORK_DELAY_MS));
}

/** Stand-in for the real reachability probe: replays whatever the fixture declares, without
 *  sending a request. The default client uses the real one — see `defaultClient.ts`. */
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

/** The scenario library is a folder on the orchestrator's disk, so there is nothing to mock: a
 *  hardcoded stand-in would be a *different* library from the one the app actually opens, and the
 *  Load screen's file drop zone works without any of this anyway. The default client uses the
 *  real implementation (see `defaultClient.ts`), which the Vite dev server also serves in-process. */
const LIBRARY_NEEDS_BACKEND = "The scenario library is served from a folder by the Kaigara backend (npm run dev -w backend).";

const scenariosRequireBackend = {
  library: () => Promise.reject(new Error(LIBRARY_NEEDS_BACKEND)),
  templates: () => Promise.reject(new Error(LIBRARY_NEEDS_BACKEND)),
  instantiate: () => Promise.reject(new Error(LIBRARY_NEEDS_BACKEND)),
} satisfies ApiClient["scenarios"];

/** Executing a timeline needs a real engine subprocess, which only the backend has. Rather than
 *  fake a run — which would put invented latency numbers in front of a user who came here to
 *  measure real ones — these fail loudly. The default client replaces them with the real
 *  implementation (see `defaultClient.ts`); this stub only covers a mock-only composition. */
const requiresBackend = {
  start: () => Promise.reject(new Error("Starting a run requires the Kaigara backend (npm run dev -w backend).")),
  stop: () => Promise.reject(new Error("Stopping a run requires the Kaigara backend.")),
  detail: () => Promise.reject(new Error("Run detail requires the Kaigara backend.")),
  subscribeDetail: () => () => {},
  compile: () => Promise.reject(new Error("Compiling a timeline requires the Kaigara backend.")),
  engines: () => Promise.resolve([]),
} satisfies Partial<ApiClient["runs"]>;

export function createMockApiClient(): ApiClient {
  return {
    connections: createConnectionsClient({ probe: mockProbe, persistLocally: false }),
    scenarios: scenariosRequireBackend,
    runs: {
      ...requiresBackend,
      get: () => delay(mockRunState),
      subscribe: (_runId, onUpdate) => {
        let elapsed = mockRunState.elapsedSeconds;
        const rps = [...mockRunState.requestsPerSecondSeries];
        const errorLog = [...mockRunState.errorLog];

        const interval = setInterval(() => {
          elapsed = Math.min(elapsed + 1, mockRunState.totalSeconds);
          if (elapsed % 3 === 0) {
            const last = rps.at(-1) ?? 400;
            rps.push(Math.max(50, last + Math.round((Math.random() - 0.45) * 60)));
            if (rps.length > 30) rps.shift();
          }
          onUpdate({ ...mockRunState, elapsedSeconds: elapsed, requestsPerSecondSeries: rps, errorLog });
        }, 1000);

        return () => clearInterval(interval);
      },
    },
    analysis: {
      get: () => delay(mockRunAnalysis),
    },
  };
}
