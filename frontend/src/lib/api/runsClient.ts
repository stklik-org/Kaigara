import type {
  ConcretePlan,
  EngineDescriptorView,
  LoadTimeline,
  RunView,
  ServerConnection,
  StartRunRequest,
  ValidationIssue,
} from "@kaigara/shared-types";
import { ApiRequestError, readJsonOrThrow } from "./httpError";

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

/** Thrown when the backend rejects a run request; carries the validator's per-path issues. */
export class RunRequestError extends ApiRequestError {}

const runFailure = (message: string, status: number, issues: ValidationIssue[]) =>
  new RunRequestError(message, status, issues);

export interface StartRunOptions {
  timeline: LoadTimeline;
  /** The target to run against. Its `baseUrl`, timeout and `headers` are what the engine actually
   *  uses — the same credentials the Connect screen's "Test" probes with. */
  connection: Pick<ServerConnection, "id" | "baseUrl" | "defaultTimeoutSeconds" | "headers">;
  scenarioName?: string;
  dryRun?: boolean;
}

function toRequest({ timeline, connection, scenarioName, dryRun }: StartRunOptions): StartRunRequest {
  return {
    // The same serialization the Code view renders, so what runs is exactly what the user read.
    timeline: timeline.toJSON(),
    target: { baseUrl: connection.baseUrl, timeoutSeconds: connection.defaultTimeoutSeconds, headers: connection.headers },
    connectionId: connection.id,
    scenarioName,
    dryRun,
  };
}

export interface RunsClient {
  /** Serializes `timeline` and asks the backend to execute it. Resolves once the run has been
   *  accepted and started — not when it finishes. */
  start(options: StartRunOptions): Promise<RunView>;
  /** A run and everything known about it: plan, live state, metrics, warnings, artifacts. */
  detail(runId: string): Promise<RunView>;
  /** Live stream of that same view. Returns an unsubscribe function. */
  subscribeDetail(runId: string, onUpdate: (view: RunView) => void): () => void;
  stop(runId: string): Promise<RunView>;
  /** Compiles without executing, returning the generated engine script for inspection. */
  compile(options: StartRunOptions): Promise<{ script: string; warnings: ValidationIssue[] }>;
  /** Expands the timeline into a bucketed, time-ordered schedule of the requests the engine will
   *  issue — the Run screen's "Concrete plan" debug view. Runs nothing. */
  concretePlan(options: StartRunOptions): Promise<ConcretePlan>;
  engines(): Promise<EngineDescriptorView[]>;
}

export function createRunsClient(baseUrl = ""): RunsClient {
  const url = (path: string): string => `${baseUrl}${path}`;
  const runUrl = (runId: string, suffix = "") => url(`${RUNS_ENDPOINT}/${encodeURIComponent(runId)}${suffix}`);

  const postJson = (endpoint: string, body?: unknown): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

  const read = <T,>(response: Response) => readJsonOrThrow<T, RunRequestError>(response, runFailure);

  return {
    async detail(runId) {
      return read<RunView>(await fetch(runUrl(runId)));
    },

    subscribeDetail(runId, onUpdate) {
      const source = new EventSource(runUrl(runId, "/events"));

      source.addEventListener("state", (event) => {
        try {
          onUpdate(JSON.parse((event as MessageEvent).data) as RunView);
        } catch {
          // A malformed frame should not tear down a live run's view; the next one will be fine.
        }
      });
      // The backend closes the stream itself once the run reaches a terminal state. Without this
      // the browser would treat that close as a drop and reconnect forever against a finished run.
      source.addEventListener("end", () => source.close());

      return () => source.close();
    },

    async start(options) {
      return read<RunView>(await postJson(url(RUNS_ENDPOINT), toRequest(options)));
    },

    async stop(runId) {
      return read<RunView>(await postJson(runUrl(runId, "/stop")));
    },

    async compile(options) {
      const response = await postJson(url(`${RUNS_ENDPOINT}/compile`), toRequest({ ...options, dryRun: true }));
      const body = await read<{ script: string; warnings?: ValidationIssue[] }>(response);
      return { script: body.script, warnings: body.warnings ?? [] };
    },

    async concretePlan(options) {
      const response = await postJson(url(`${RUNS_ENDPOINT}/concrete-plan`), toRequest(options));
      return read<ConcretePlan>(response);
    },

    async engines() {
      return (await read<{ engines: EngineDescriptorView[] }>(await fetch(url(ENGINES_ENDPOINT)))).engines;
    },
  };
}
