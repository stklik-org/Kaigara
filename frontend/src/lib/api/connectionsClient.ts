import type {
  ConnectionInput,
  ConnectionTestRequest,
  ConnectionTestResult,
  ServerConnection,
} from "@kaigara/shared-types";
import type { ConnectionsClient } from "./client";
import { readJson, writeJson } from "../storage";
import { mockConnections } from "../mock/connections";
import { applyTwinsphereDevDefaults } from "./twinsphereDevDefaults";

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

const DEFAULT_CONNECTION = {
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
  headers: {},
} as const satisfies Omit<ServerConnection, "id">;

export type ConnectionProbe = (connection: ServerConnection) => Promise<ConnectionTestResult>;

/** A result that says nothing about the target server, only that Kaigara could not ask. Kept
 *  distinct from "unreachable" so a missing backend never gets reported as a dead server. */
function probeUnavailable(connection: ServerConnection, detail: string): ConnectionTestResult {
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
 *  target is contacted from Node, where CORS does not apply and TLS/DNS/connection errors can be
 *  told apart. */
const httpProbe: ConnectionProbe = async (connection) => {
  const request: ConnectionTestRequest = {
    baseUrl: connection.baseUrl,
    timeoutSeconds: connection.defaultTimeoutSeconds,
    // So "Test" sees exactly what a run against this connection would send — a probe that
    // succeeds unauthenticated but a run that then 401s would be a worse surprise than the
    // reverse.
    headers: connection.headers,
  };

  let response: Response;
  try {
    response = await fetch(PROBE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return probeUnavailable(
      connection,
      `Kaigara's probe service is not reachable at ${PROBE_ENDPOINT}. Start the backend (npm run dev -w backend) — this says nothing about the target server.`,
    );
  }

  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return probeUnavailable(
      connection,
      `The probe service answered HTTP ${response.status} with a non-JSON body — is ${PROBE_ENDPOINT} routed to the Kaigara backend?`,
    );
  }
  if (!response.ok) {
    const message = (payload as { error?: string })?.error ?? `HTTP ${response.status}`;
    return probeUnavailable(connection, `The probe service rejected the request: ${message}`);
  }
  return payload as ConnectionTestResult;
};

function isConnectionList(value: unknown): value is ServerConnection[] {
  return Array.isArray(value) && value.length > 0;
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
    headers: input.headers ?? connection.headers,
  };
}

export function createConnectionsClient(
  options: { probe?: ConnectionProbe; persistLocally?: boolean } = {},
): ConnectionsClient {
  const { probe = httpProbe, persistLocally = true } = options;
  const stored = persistLocally ? readJson(STORAGE_KEY, isConnectionList) : null;
  let connections: ServerConnection[] = applyTwinsphereDevDefaults(stored ?? mockConnections.map((c) => ({ ...c })));

  const save = () => {
    if (persistLocally) writeJson(STORAGE_KEY, connections);
  };
  save();
  // Handed out as copies so a screen holding the previous list can't mutate this one's state.
  const copy = (connection: ServerConnection) => ({ ...connection });
  const mustFind = (id: string): ServerConnection => {
    const found = connections.find((c) => c.id === id);
    if (!found) throw new Error(`No connection with id "${id}".`);
    return found;
  };
  /** Rewrites one connection from whatever the list holds *now*, and persists. Reading the current
   *  value here rather than at the call site matters for `test()`: the probe is awaited first, and
   *  an edit made in the meantime must not be rolled back by its result. */
  const patch = (id: string, change: (current: ServerConnection) => ServerConnection): ServerConnection => {
    const next = change(mustFind(id));
    connections = connections.map((c) => (c.id === id ? next : c));
    save();
    return next;
  };

  return {
    list: async () => connections.map(copy),

    create: async (input) => {
      const created = applyInput({ id: crypto.randomUUID(), ...DEFAULT_CONNECTION }, input);
      connections = [...connections, created];
      save();
      return copy(created);
    },

    update: async (id, input) =>
      copy(
        patch(id, (current) => {
          const edited = applyInput(current, input);
          // A changed base URL invalidates whatever the last probe found.
          return edited.baseUrl === current.baseUrl
            ? edited
            : { ...edited, reachable: "unknown" as const, lastTest: undefined };
        }),
      ),

    remove: async (id) => {
      connections = connections.filter((c) => c.id !== id);
      save();
    },

    activate: async (id) => {
      connections = connections.map((c) => ({ ...c, active: c.id === id }));
      save();
    },

    test: async (id) => {
      const result = await probe(mustFind(id));
      patch(id, (current) => ({
        ...current,
        // A probe service that never ran says nothing about the target server, so the connection's
        // own reachability must not be overwritten in that case.
        reachable: result.error?.kind === "probe-unavailable" ? current.reachable : result.reachable,
        lastTest: result,
      }));
      return result;
    },
  };
}
