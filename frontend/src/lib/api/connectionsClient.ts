import type {
  ConnectionInput,
  ConnectionTestRequest,
  ConnectionTestResult,
  ServerConnection,
} from "@kaigara/shared-types";
import type { ApiClient } from "./client";
import { mockConnections } from "../mock/connections";

/**
 * Connections are the one part of the API seam that is real rather than mocked: `test()` actually
 * probes the target server (via the backend's `POST /api/connections/test`, which the Vite dev
 * server also mounts in-process — see `frontend/vite.config.ts`), and the list itself is the
 * user's own, persisted locally.
 *
 * Persistence is `localStorage` on purpose and only for now: the backend does not own connections
 * yet (`backend/README.md`, `src/connections/`), so this keeps the user's targets across reloads
 * without inventing a storage API the real orchestrator will have to honour later. When the
 * backend grows connection CRUD, only this module changes.
 */

const STORAGE_KEY = "kaigara.connections.v1";
const PROBE_ENDPOINT = "/api/connections/test";

export type ConnectionProbe = (connection: ServerConnection) => Promise<ConnectionTestResult>;

function unreachableProbeResult(connection: ServerConnection, detail: string): ConnectionTestResult {
  return {
    reachable: false,
    probedUrl: connection.baseUrl,
    probedEndpoint: "description",
    detail,
    error: { kind: "probe-unavailable", message: detail },
    checkedAt: new Date().toISOString(),
  };
}

/** Asks the backend to probe the server. The request never leaves the browser's own origin — the
 *  target server is contacted from Node, where CORS does not apply and TLS/DNS/connection errors
 *  can be told apart. */
const httpProbe: ConnectionProbe = async (connection) => {
  const request: ConnectionTestRequest = {
    baseUrl: connection.baseUrl,
    timeoutSeconds: connection.defaultTimeoutSeconds,
  };
  let response: Response;
  try {
    response = await fetch(PROBE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return unreachableProbeResult(
      connection,
      `Kaigara's probe service is not reachable at ${PROBE_ENDPOINT}. Start the backend (npm run dev -w backend) — this says nothing about the target server.`,
    );
  }

  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return unreachableProbeResult(
      connection,
      `The probe service answered HTTP ${response.status} with a non-JSON body — is ${PROBE_ENDPOINT} routed to the Kaigara backend?`,
    );
  }
  if (!response.ok) {
    const message = (payload as { error?: string })?.error ?? `HTTP ${response.status}`;
    return unreachableProbeResult(connection, `The probe service rejected the request: ${message}`);
  }
  return payload as ConnectionTestResult;
};

function loadStored(): ServerConnection[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ServerConnection[]) : null;
  } catch {
    return null;
  }
}

function persist(connections: ServerConnection[], enabled: boolean) {
  if (!enabled) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
  } catch {
    // Private-mode / quota failures are not worth interrupting the user over.
  }
}

function applyInput(connection: ServerConnection, input: ConnectionInput): ServerConnection {
  return {
    ...connection,
    name: input.name.trim() || connection.name,
    baseUrl: input.baseUrl.trim(),
    environment: input.environment?.trim() ?? connection.environment,
    apiVersion: input.apiVersion?.trim() || connection.apiVersion,
    conformanceProfile: input.conformanceProfile?.trim() || connection.conformanceProfile,
    defaultTimeoutSeconds: input.defaultTimeoutSeconds ?? connection.defaultTimeoutSeconds,
    scrapeResourceMetrics: input.scrapeResourceMetrics ?? connection.scrapeResourceMetrics,
  };
}

export function createConnectionsClient(
  options: { probe?: ConnectionProbe; persistLocally?: boolean } = {},
): ApiClient["connections"] {
  const { probe = httpProbe, persistLocally = true } = options;
  const seeded = persistLocally ? loadStored() : null;
  let connections: ServerConnection[] = seeded ?? mockConnections.map((c) => ({ ...c }));

  const save = () => persist(connections, persistLocally);
  const copy = (connection: ServerConnection) => ({ ...connection });
  const find = (id: string) => connections.find((c) => c.id === id);

  return {
    list: async () => connections.map(copy),

    create: async (input) => {
      const created: ServerConnection = applyInput(
        {
          id: crypto.randomUUID(),
          name: "New connection",
          environment: "",
          baseUrl: "",
          apiVersion: "IDTA-01002-3.1",
          conformanceProfile: "not declared",
          conformanceStatus: "unknown",
          reachable: "unknown",
          active: false,
          defaultTimeoutSeconds: 30,
          scrapeResourceMetrics: false,
        },
        input,
      );
      connections = [...connections, created];
      save();
      return copy(created);
    },

    update: async (id, input) => {
      const existing = find(id);
      if (!existing) throw new Error(`No connection with id "${id}".`);
      // A changed base URL invalidates whatever the last probe found.
      const edited = applyInput(existing, input);
      const changedTarget = edited.baseUrl !== existing.baseUrl;
      const next: ServerConnection = changedTarget
        ? { ...edited, reachable: "unknown", lastTest: undefined }
        : edited;
      connections = connections.map((c) => (c.id === id ? next : c));
      save();
      return copy(next);
    },

    remove: async (id) => {
      connections = connections.filter((c) => c.id !== id);
      save();
    },

    activate: async (id) => {
      connections = connections.map((c) => ({ ...c, active: c.id === id }));
      save();
    },

    test: async (id) => {
      const connection = find(id);
      if (!connection) throw new Error(`No connection with id "${id}".`);
      const result = await probe(connection);
      // A probe service that never ran says nothing about the target server, so the connection's
      // own reachability must not be overwritten in that case.
      const reachable = result.error?.kind === "probe-unavailable" ? connection.reachable : result.reachable;
      connections = connections.map((c) => (c.id === id ? { ...c, reachable, lastTest: result } : c));
      save();
      return result;
    },
  };
}
