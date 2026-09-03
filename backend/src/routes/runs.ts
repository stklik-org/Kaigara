/**
 * HTTP surface for compiling and executing a timeline.
 *
 * `POST /api/runs` is the endpoint the Compose screen's Run button posts a serialized timeline to.
 * Everything else exists to make that one honest: `/compile` shows what a timeline *would* do
 * without running it, `/events` streams the run live, `/artifacts/:name` hands back the exact
 * script that was executed, and `/engines` answers "is k6 even installed" before a user discovers
 * it is not by watching a run fail.
 */

import type { FastifyInstance } from "fastify";

import { TimelineValidationError } from "@kaigara/shared-types";
import type { EngineRegistry } from "../engines/adapter.ts";
import {
  EmptyPlanError,
  EngineUnavailableError,
  InvalidTargetError,
  RunNotFoundError,
  type CreateRunRequest,
  type RunService,
  type RunView,
} from "../runs/runService.ts";

/** SSE comment sent periodically so proxies and browsers keep the stream open through quiet
 *  stretches (a run whose method phase has not started yet emits nothing for a while). */
const SSE_KEEPALIVE_MS = 15000;

function statusForError(error: unknown): number {
  if (error instanceof TimelineValidationError) return 422;
  if (error instanceof InvalidTargetError || error instanceof EmptyPlanError) return 400;
  if (error instanceof RunNotFoundError) return 404;
  if (error instanceof EngineUnavailableError) return 503;
  return 500;
}

function errorBody(error: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { error: (error as Error).message ?? "Unknown error" };
  // Validation failures carry the full issue list with paths, which is what lets the editor point
  // at the offending line rather than just saying "invalid".
  if (error instanceof TimelineValidationError) body.issues = error.issues;
  return body;
}

export function registerRunRoutes(app: FastifyInstance, deps: { runs: RunService; engines: EngineRegistry }): void {
  const { runs, engines } = deps;

  /** Which engines this build can actually run, and their versions. */
  app.get("/api/engines", async () => {
    const adapters = engines.list();
    const availability = await Promise.all(
      adapters.map(async (adapter) => ({
        id: adapter.id,
        name: adapter.name,
        ...(await adapter.probe()),
      })),
    );
    return { engines: availability };
  });

  /**
   * Compiles a timeline and returns the plan plus the generated engine script, without executing
   * anything and without creating a run.
   */
  app.post<{ Body: CreateRunRequest }>("/api/runs/compile", async (request, reply) => {
    try {
      const { plan, script, warnings } = runs.compileOnly(request.body);
      return { plan, script, warnings };
    } catch (error) {
      return reply.code(statusForError(error)).send(errorBody(error));
    }
  });

  /**
   * Accepts a serialized `LoadTimeline` and executes it.
   *
   * Body: `{ timeline, target: { baseUrl, timeoutSeconds?, headers? }, scenarioName?,
   * connectionId?, engineId?, dryRun? }`.
   */
  app.post<{ Body: CreateRunRequest }>("/api/runs", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || body.timeline === undefined) {
      return reply
        .code(400)
        .send({ error: "Body must be { timeline, target: { baseUrl }, … }. See backend/README.md." });
    }
    try {
      const view = await runs.create(body);
      return reply.code(201).send(view);
    } catch (error) {
      request.log.warn({ err: error }, "run creation failed");
      return reply.code(statusForError(error)).send(errorBody(error));
    }
  });

  app.get("/api/runs", async () => ({ runs: runs.list() }));

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    try {
      return runs.get(request.params.id);
    } catch (error) {
      return reply.code(statusForError(error)).send(errorBody(error));
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (request, reply) => {
    try {
      return await runs.stop(request.params.id);
    } catch (error) {
      return reply.code(statusForError(error)).send(errorBody(error));
    }
  });

  /** The generated script (or plan) for a run, so the user can read exactly what was executed. */
  app.get<{ Params: { id: string; name: string } }>("/api/runs/:id/artifacts/:name", async (request, reply) => {
    try {
      const { artifact, content } = await runs.readArtifact(request.params.id, request.params.name);
      return reply.type(artifact.contentType).send(content);
    } catch (error) {
      return reply.code(statusForError(error)).send(errorBody(error));
    }
  });

  /**
   * Live run state as Server-Sent Events.
   *
   * SSE rather than a WebSocket: the stream is one-directional (control actions are ordinary POSTs),
   * it survives proxies without an upgrade handshake, and the browser reconnects on its own. The
   * proposal (section 7.2) allows either; this is the cheaper half.
   */
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", (request, reply) => {
    let unsubscribe: (() => void) | undefined;
    try {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // The run stream is read cross-origin from the Vite dev server.
        "access-control-allow-origin": request.headers.origin ?? "*",
      });

      const send = (view: RunView): void => {
        reply.raw.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
        if (view.status !== "running" && view.status !== "starting") {
          reply.raw.write("event: end\ndata: {}\n\n");
          cleanup();
          reply.raw.end();
        }
      };

      const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), SSE_KEEPALIVE_MS);

      const cleanup = (): void => {
        clearInterval(keepalive);
        unsubscribe?.();
        unsubscribe = undefined;
      };

      unsubscribe = runs.subscribe(request.params.id, send);
      request.raw.on("close", cleanup);
    } catch (error) {
      unsubscribe?.();
      if (!reply.raw.headersSent) {
        return reply.code(statusForError(error)).send(errorBody(error));
      }
      reply.raw.end();
    }
  });
}
