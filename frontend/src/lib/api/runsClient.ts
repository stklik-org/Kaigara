import type {
  ConcretePlan,
  EngineDescriptorView,
  LoadTimeline,
  RunArchiveDetail,
  RunArchiveEntry,
  RunExchange,
  RunRequestLog,
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
  /** The target to run against. Its `baseUrl`, timeout, `headers` and `oauth2` are what the
   *  engine actually uses — the same credentials the Connect screen's "Test" probes with. */
  connection: Pick<ServerConnection, "id" | "baseUrl" | "defaultTimeoutSeconds" | "headers" | "oauth2">;
  scenarioName?: string;
  dryRun?: boolean;
}

function toRequest({ timeline, connection, scenarioName, dryRun }: StartRunOptions): StartRunRequest {
  return {
    // The same serialization the Code view renders, so what runs is exactly what the user read.
    timeline: timeline.toJSON(),
    target: {
      baseUrl: connection.baseUrl,
      timeoutSeconds: connection.defaultTimeoutSeconds,
      headers: connection.headers,
      oauth2: connection.oauth2,
    },
    connectionId: connection.id,
    scenarioName,
    dryRun,
  };
}

/** One file of a compiled run: `main.js`, or one of the numbered scripts it schedules. */
export interface GeneratedScriptFile {
  name: string;
  content: string;
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
  /** Compiles without executing, returning every generated engine file for inspection: `main.js`
   *  first, then one small script per request type of each load. */
  compile(options: StartRunOptions): Promise<{ files: GeneratedScriptFile[]; warnings: ValidationIssue[] }>;
  /** Expands the timeline into a bucketed, time-ordered schedule of the requests the engine will
   *  issue — the Run screen's "Concrete plan" debug view. Runs nothing. */
  concretePlan(options: StartRunOptions): Promise<ConcretePlan>;
  /** One Load's complete per-request log — not the bounded live tail
   *  `RunView.metrics.recentSamples` carries. Its own request rather than folded into
   *  `detail`/`subscribeDetail` so fetching it is a deliberate, one-off choice the caller makes
   *  (normally once a Load is selected on a finished run), never something paid for on every live
   *  tick, and never for the whole run at once — omitting `loadId` gets back no samples. Works for
   *  an archived run's `runId` too, not just a live one. */
  requestLog(runId: string, loadId?: string): Promise<RunRequestLog>;
  /** One row's captured request and response, for the "open this row" popup — fetched only when a
   *  row is actually clicked, never preloaded for the whole table. Read from the run's log folder,
   *  so it works for a live run and an archived one alike. */
  exchange(runId: string, exchangeId: string): Promise<RunExchange>;
  /** "Open previous execution": every run the k6 adapter's own on-disk archive still has a
   *  manifest for, across every backend restart — unlike `list()`-from-memory (not exposed here;
   *  see `GET /api/runs`), this is what survives one. */
  archiveList(): Promise<RunArchiveEntry[]>;
  /** Reopens one archived run by the `id` an `archiveList()` entry gave it. */
  archiveDetail(id: string): Promise<RunArchiveDetail>;
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
      const body = await read<{ files?: GeneratedScriptFile[]; warnings?: ValidationIssue[] }>(response);
      return { files: body.files ?? [], warnings: body.warnings ?? [] };
    },

    async concretePlan(options) {
      const response = await postJson(url(`${RUNS_ENDPOINT}/concrete-plan`), toRequest(options));
      return read<ConcretePlan>(response);
    },

    async requestLog(runId, loadId) {
      const query = loadId !== undefined ? `?loadId=${encodeURIComponent(loadId)}` : "";
      return read<RunRequestLog>(await fetch(runUrl(runId, `/requests${query}`)));
    },

    async exchange(runId, exchangeId) {
      return read<RunExchange>(await fetch(runUrl(runId, `/exchanges/${encodeURIComponent(exchangeId)}`)));
    },

    async archiveList() {
      return (await read<{ entries: RunArchiveEntry[] }>(await fetch(url(`${RUNS_ENDPOINT}/archive`)))).entries;
    },

    async archiveDetail(id) {
      return read<RunArchiveDetail>(await fetch(url(`${RUNS_ENDPOINT}/archive/${encodeURIComponent(id)}`)));
    },

    async engines() {
      return (await read<{ engines: EngineDescriptorView[] }>(await fetch(url(ENGINES_ENDPOINT)))).engines;
    },
  };
}
