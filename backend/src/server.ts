import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { ConnectionTestRequest } from "@kaigara/shared-types";
import { probeConnection } from "./connections/probe.ts";
import { EngineRegistry } from "./engines/adapter.ts";
import { K6Adapter } from "./engines/k6/k6Adapter.ts";
import { RunService } from "./runs/runService.ts";
import { registerRunRoutes } from "./routes/runs.ts";
import { registerScenarioRoutes } from "./routes/scenarios.ts";
import { SWAGGER_ROUTE_PREFIX, registerOpenApi } from "./routes/openapi.ts";
import { documented, errorResponse } from "./routes/apiSchemas.ts";

/**
 * The orchestrator described in `backend/README.md`. Three slices are implemented:
 *
 *  - the connection reachability probe, so the Connect screen's "Test" button asks a real server a
 *    real question, and
 *  - timeline execution: `POST /api/runs` takes a serialized `LoadTimeline`, compiles it into a
 *    k6 execution plan and then into a k6 script, and runs it against a target AAS server, and
 *  - the scenario library: `GET /api/scenarios` serves a folder of serialized scenario documents,
 *    which is what the Load screen offers to open.
 *
 * The preparation/correctness phases and run history are still unimplemented, and the library is
 * read-only — a scenario is saved by writing a file into the folder, not through this API.
 *
 * The whole surface is browsable and executable at `/swagger` (Swagger UI), which is how you drive a
 * benchmark without the frontend: paste or name a scenario, point it at a server, press Execute.
 *
 * Setting `KAIGARA_UI_DIR` to the frontend's build output makes this process serve the UI as well,
 * on its own origin — which is what turns "a frontend and a backend" into one container and one
 * port (see the repository Dockerfile). It is off unless the variable is set, so development is
 * unaffected: there, Vite serves the UI and proxies `/api` here.
 *
 * Run with `npm run dev -w backend` (Node >= 22.6 strips the types natively, no build step).
 * The Vite dev server mounts the same `probeConnection` and scenario-library modules in-process,
 * so during frontend-only development you do not need this running for the Connect and Load
 * screens; see `frontend/vite.config.ts`. Running a benchmark still needs this process.
 */

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? "127.0.0.1";

/** `logger` is a parameter only so tests can build the app without a request log on stdout;
 *  everything else about the server is the same one `npm run dev -w backend` starts. */
export async function createServer({ logger = true }: { logger?: boolean } = {}) {
  const app = Fastify({ logger });

  // Kaigara is local-first software: the browser talking to this process is served from the Vite
  // dev server on a different port, so the API has to be readable cross-origin.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });

  // Before the routes: `@fastify/swagger` collects the schemas of what is registered after it.
  await registerOpenApi(app);

  // ADR 0001: only the k6 adapter is registered. Additional engines are a registration plus a
  // config choice, not a redesign — which is the whole point of the seam.
  const engines = new EngineRegistry();
  engines.register(new K6Adapter());
  const runs = new RunService(engines);

  app.get(
    "/api/health",
    documented({
      tags: ["meta"],
      summary: "Liveness check",
      response: {
        200: {
          description: "The service is up.",
          type: "object",
          properties: { ok: { type: "boolean" }, service: { type: "string" } },
        },
      },
    }),
    async () => ({ ok: true, service: "kaigara-backend" }),
  );

  registerRunRoutes(app, { runs, engines });
  registerScenarioRoutes(app);

  app.post<{ Body: ConnectionTestRequest }>(
    "/api/connections/test",
    documented({
      tags: ["connections"],
      summary: "Probe an AAS server for reachability and conformance",
      description:
        "Asks the target for its IDTA-01002 Service Description (`GET {baseUrl}/description`), falling back to `GET {baseUrl}/shells` for servers that do not implement it. Reports latency, HTTP status, the advertised conformance profiles, and a classified error (DNS / refused / TLS / timeout / HTTP) when it fails. Standards-only: no vendor health endpoints.\n\nIt runs here rather than in the browser because CORS would make an arbitrary AAS server unreachable and indistinguishable from a down one.",
      body: {
        type: "object",
        required: ["baseUrl"],
        properties: {
          baseUrl: { type: "string", description: "API root of the AAS server." },
          timeoutSeconds: { type: "number", minimum: 0 },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra headers to send with the probe — the same ones a run against this connection would use, e.g. an Authorization bearer token.",
          },
        },
        example: { baseUrl: "http://127.0.0.1:8081/api/v3" },
      },
      response: {
        200: {
          description: "The probe result — including a failed probe, which is an answer, not an error.",
          type: "object",
          additionalProperties: true,
          properties: {
            reachable: { type: "string", description: '"yes" / "no" / "unknown".' },
            latencyMs: { type: "number" },
            httpStatus: { type: "number" },
            profiles: { type: "array", items: { type: "string" }, description: "Advertised IDTA conformance profiles." },
            error: { type: "object", additionalProperties: true },
          },
        },
        400: errorResponse("No `baseUrl` in the body."),
      },
    }),
    async (request, reply) => {
      const { baseUrl, timeoutSeconds, headers } = request.body ?? ({} as ConnectionTestRequest);
      if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
        return reply.code(400).send({ error: "Body must be { baseUrl: string, timeoutSeconds?: number, headers?: object }." });
      }
      return probeConnection({ baseUrl, timeoutSeconds, headers });
    },
  );

  await registerUi(app);

  return app;
}

/**
 * Serves the built frontend from this process when `KAIGARA_UI_DIR` points at it.
 *
 * Same origin as the API, which is the whole point: the frontend addresses the backend with
 * relative `/api/...` paths (see `frontend/src/lib/api/`), so served this way it needs no proxy,
 * no CORS and no build-time base URL — nothing to configure and nothing to get wrong.
 *
 * A missing directory is a warning rather than a crash: an API-only deployment is a legitimate way
 * to run this, and the orchestrator refusing to start because a static file is absent would be a
 * poor trade.
 */
async function registerUi(app: FastifyInstance): Promise<void> {
  const configured = process.env.KAIGARA_UI_DIR;
  if (!configured) return;

  const root = resolve(configured);
  if (!existsSync(root)) {
    app.log.warn({ root }, "KAIGARA_UI_DIR is set but does not exist — serving the API only");
    return;
  }

  await app.register(fastifyStatic, { root });

  // The UI is client-routed, so a deep link like /compose has no file behind it. Anything that is
  // not an API call and not a file on disk is handed index.html and resolved in the browser; API
  // paths keep their JSON 404 so a mistyped endpoint does not answer with a page.
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` });
    }
    return reply.sendFile("index.html");
  });

  app.log.info({ root }, "serving the Kaigara UI");
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await createServer();
  app
    .listen({ port: PORT, host: HOST })
    .then(() => app.log.info(`Kaigara backend listening on http://${HOST}:${PORT} — API docs at http://${HOST}:${PORT}${SWAGGER_ROUTE_PREFIX}`))
    .catch((err: NodeJS.ErrnoException) => {
      // A second copy is the common mistake, and a Fastify error dump buries it. Say it plainly:
      // under `node --watch` the supervisor survives this exit and keeps the terminal open, so
      // without a clear line here it looks like the server started.
      if (err.code === "EADDRINUSE") {
        app.log.error(
          `Port ${PORT} is already in use — a Kaigara backend is already running. ` +
            "Stop it with `npm run stop`, or set PORT to run a second one deliberately.",
        );
      } else {
        app.log.error(err);
      }
      process.exit(1);
    });
}
