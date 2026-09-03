import type {
  EngineDescriptorView,
  LoadTimeline,
  RunState,
  RunView,
  ServerConnection,
  StartRunRequest,
  ValidationIssue,
} from "@kaigara/shared-types";

/**
 * The real, backend-backed `runs` slice: it serializes the composed timeline, posts it to the
 * orchestrator, and streams the resulting run back.
 *
 * Serialization is deliberately just `JSON.stringify(timeline)` — `LoadTimeline.toJSON()` cascades
 * through Track/Load/LoadShape/RequestComposition, so the document that goes over the wire is
 * byte-for-byte the one the Compose screen's Code view shows. There is no separate export format
 * to keep in sync, which is the same reason the two views share one document.
 *
 * Live updates arrive over Server-Sent Events rather than polling: the backend already aggregates
 * per second (proposal §7.2), so the stream is one small message a second and the browser
 * reconnects on its own if it drops.
 */

const RUNS_ENDPOINT = "/api/runs";
const ENGINES_ENDPOINT = "/api/engines";

/** Thrown when the backend rejects a timeline. Carries the validator's per-path issues so the
 *  caller can point at the offending value instead of just reporting "invalid". */
export class RunRequestError extends Error {
  readonly issues: ValidationIssue[];
  readonly status: number;

  constructor(message: string, status: number, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "RunRequestError";
    this.status = status;
    this.issues = issues;
  }
}

async function failure(response: Response): Promise<RunRequestError> {
  let message = `${response.status} ${response.statusText}`;
  let issues: ValidationIssue[] = [];
  try {
    const body = await response.json();
    if (typeof body?.error === "string") message = body.error;
    if (Array.isArray(body?.issues)) issues = body.issues;
  } catch {
    // A non-JSON error body (a proxy's HTML 502, say) leaves the status line as the message.
  }
  return new RunRequestError(message, response.status, issues);
}

export interface StartRunOptions {
  timeline: LoadTimeline;
  /** The target to run against. Its `baseUrl` and timeout are what the engine actually uses. */
  connection: Pick<ServerConnection, "id" | "baseUrl" | "defaultTimeoutSeconds">;
  scenarioName?: string;
  dryRun?: boolean;
}

function toRequest({ timeline, connection, scenarioName, dryRun }: StartRunOptions): StartRunRequest {
  return {
    // `toJSON()` via structured clone of the class instance — the same serialization the Code view
    // renders, so what runs is exactly what the user read.
    timeline: timeline.toJSON(),
    target: { baseUrl: connection.baseUrl, timeoutSeconds: connection.defaultTimeoutSeconds },
    connectionId: connection.id,
    scenarioName,
    dryRun,
  };
}

export interface RunsClient {
  get(runId: string): Promise<RunState>;
  subscribe(runId: string, onUpdate: (state: RunState) => void): () => void;
  /** Serializes `timeline` and asks the backend to execute it. Resolves once the run has been
   *  accepted and started — not when it finishes. */
  start(options: StartRunOptions): Promise<RunView>;
  /** Full run detail (plan, metrics, warnings, artifacts), beyond the `RunState` the Run screen
   *  renders. */
  detail(runId: string): Promise<RunView>;
  /** Live full-detail stream. Returns an unsubscribe function. */
  subscribeDetail(runId: string, onUpdate: (view: RunView) => void): () => void;
  stop(runId: string): Promise<RunView>;
  /** Compiles without executing, returning the generated engine script for inspection. */
  compile(options: StartRunOptions): Promise<{ script: string; warnings: ValidationIssue[] }>;
  engines(): Promise<EngineDescriptorView[]>;
}

export function createRunsClient(baseUrl = ""): RunsClient {
  const url = (path: string): string => `${baseUrl}${path}`;

  async function detail(runId: string): Promise<RunView> {
    const response = await fetch(url(`${RUNS_ENDPOINT}/${encodeURIComponent(runId)}`));
    if (!response.ok) throw await failure(response);
    return response.json();
  }

  /** One SSE subscription, projected through `select` so both `subscribe` (RunState, for the Run
   *  screen) and `subscribeDetail` (full view) share a single connection shape. */
  function stream<T>(runId: string, select: (view: RunView) => T, onUpdate: (value: T) => void): () => void {
    const source = new EventSource(url(`${RUNS_ENDPOINT}/${encodeURIComponent(runId)}/events`));

    source.addEventListener("state", (event) => {
      try {
        onUpdate(select(JSON.parse((event as MessageEvent).data)));
      } catch {
        // A malformed frame should not tear down a live run's view; the next one will be fine.
      }
    });
    // The backend closes the stream itself once the run reaches a terminal state. Without this the
    // browser would treat that close as a drop and reconnect forever against a finished run.
    source.addEventListener("end", () => source.close());

    return () => source.close();
  }

  return {
    async get(runId) {
      return (await detail(runId)).state;
    },

    subscribe(runId, onUpdate) {
      return stream(runId, (view) => view.state, onUpdate);
    },

    subscribeDetail(runId, onUpdate) {
      return stream(runId, (view) => view, onUpdate);
    },

    detail,

    async start(options) {
      const response = await fetch(url(RUNS_ENDPOINT), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toRequest(options)),
      });
      if (!response.ok) throw await failure(response);
      return response.json();
    },

    async stop(runId) {
      const response = await fetch(url(`${RUNS_ENDPOINT}/${encodeURIComponent(runId)}/stop`), { method: "POST" });
      if (!response.ok) throw await failure(response);
      return response.json();
    },

    async compile(options) {
      const response = await fetch(url(`${RUNS_ENDPOINT}/compile`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toRequest({ ...options, dryRun: true })),
      });
      if (!response.ok) throw await failure(response);
      const body = await response.json();
      return { script: body.script, warnings: body.warnings ?? [] };
    },

    async engines() {
      const response = await fetch(url(ENGINES_ENDPOINT));
      if (!response.ok) throw await failure(response);
      return (await response.json()).engines;
    },
  };
}
