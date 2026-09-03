import Fastify from "fastify";
import cors from "@fastify/cors";
import type { ConnectionTestRequest } from "@kaigara/shared-types";
import { probeConnection } from "./connections/probe.ts";
import { EngineRegistry } from "./engines/adapter.ts";
import { K6Adapter } from "./engines/k6/k6Adapter.ts";
import { RunService } from "./runs/runService.ts";
import { registerRunRoutes } from "./routes/runs.ts";
import { registerScenarioRoutes } from "./routes/scenarios.ts";

/**
 * The orchestrator described in `backend/README.md`. Three slices are implemented:
 *
 *  - the connection reachability probe, so the Connect screen's "Test" button asks a real server a
 *    real question, and
 *  - timeline execution: `POST /api/runs` takes a serialized `LoadTimeline`, compiles it into an
 *    engine-neutral plan and then into a k6 script, and runs it against a target AAS server, and
 *  - the scenario library: `GET /api/scenarios` serves a folder of serialized scenario documents,
 *    which is what the Load screen offers to open.
 *
 * The preparation/correctness phases and run history are still unimplemented, and the library is
 * read-only — a scenario is saved by writing a file into the folder, not through this API.
 *
 * Run with `npm run dev -w backend` (Node >= 22.6 strips the types natively, no build step).
 * The Vite dev server mounts the same `probeConnection` and scenario-library modules in-process,
 * so during frontend-only development you do not need this running for the Connect and Load
 * screens; see `frontend/vite.config.ts`. Running a benchmark still needs this process.
 */

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? "127.0.0.1";

export async function createServer() {
  const app = Fastify({ logger: true });

  // Kaigara is local-first software: the browser talking to this process is served from the Vite
  // dev server on a different port, so the API has to be readable cross-origin.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });

  // ADR 0001: only the k6 adapter is registered. Additional engines are a registration plus a
  // config choice, not a redesign — which is the whole point of the seam.
  const engines = new EngineRegistry();
  engines.register(new K6Adapter());
  const runs = new RunService(engines);

  app.get("/api/health", async () => ({ ok: true, service: "kaigara-backend" }));

  registerRunRoutes(app, { runs, engines });
  registerScenarioRoutes(app);

  app.post<{ Body: ConnectionTestRequest }>("/api/connections/test", async (request, reply) => {
    const { baseUrl, timeoutSeconds } = request.body ?? ({} as ConnectionTestRequest);
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      return reply.code(400).send({ error: "Body must be { baseUrl: string, timeoutSeconds?: number }." });
    }
    return probeConnection({ baseUrl, timeoutSeconds });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await createServer();
  app
    .listen({ port: PORT, host: HOST })
    .then(() => app.log.info(`Kaigara backend listening on http://${HOST}:${PORT}`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
