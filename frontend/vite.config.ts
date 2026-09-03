import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { probeConnection } from "../backend/src/connections/probe.ts";
import { ScenarioNotFoundError, listScenarios, readScenario, scenarioLibraryDir } from "../backend/src/scenarios/library.ts";
import { ScenarioFileError } from "@kaigara/shared-types";

/** Set to run the real orchestrator (`npm run dev -w backend`) instead of the in-process probe. */
const backendUrl = process.env.KAIGARA_BACKEND_URL;

/**
 * Serves `POST /api/connections/test` from the dev server itself, using the *same* module the
 * backend serves it from (`backend/src/connections/probe.ts`) — no duplicated logic, and
 * `npm run dev -w frontend` alone is enough to exercise the Connect screen's Test button.
 *
 * The probe has to run outside the browser: cross-origin reads of an arbitrary AAS server are
 * blocked by CORS, and a blocked read is indistinguishable from an unreachable server.
 * Dev-server only — a production build must talk to the real backend (see `KAIGARA_BACKEND_URL`).
 */
function connectionProbePlugin(): Plugin {
  return {
    name: "kaigara:connection-probe",
    configureServer(server) {
      server.middlewares.use("/api/connections/test", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Uint8Array[] = [];
        req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        req.on("end", async () => {
          res.setHeader("content-type", "application/json");
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            if (typeof body.baseUrl !== "string" || body.baseUrl.trim() === "") {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "Body must be { baseUrl: string, timeoutSeconds?: number }." }));
              return;
            }
            res.end(JSON.stringify(await probeConnection(body)));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        });
      });
    },
  };
}

/**
 * Serves the scenario library (`GET /api/scenarios`, `GET /api/scenarios/:id`) from the dev server,
 * using the *same* module the backend serves it from (`backend/src/scenarios/library.ts`).
 *
 * The library is a folder of JSON files, so — like the probe, and unlike a run — there is nothing
 * about it that needs the orchestrator process; it only needs a filesystem, which the dev server
 * has. That is what keeps `npm run dev -w frontend` alone enough to open the Load screen.
 * Dev-server only: a production build must talk to the real backend (see `KAIGARA_BACKEND_URL`).
 */
function scenarioLibraryPlugin(): Plugin {
  return {
    name: "kaigara:scenario-library",
    configureServer(server) {
      server.middlewares.use("/api/scenarios", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        // Vite strips the mounted prefix, so "" is the listing and "/<id>" is one scenario.
        const id = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));
        const answer = id === "" ? listScenarios() : readScenario(id);
        answer.then(
          (body) => res.end(JSON.stringify(body)),
          (err: unknown) => {
            if (err instanceof ScenarioNotFoundError) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: err.message, directory: scenarioLibraryDir() }));
              return;
            }
            if (err instanceof ScenarioFileError) {
              res.statusCode = 422;
              res.end(JSON.stringify({ error: err.message, issues: err.issues }));
              return;
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ error: (err as Error).message }));
          },
        );
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(backendUrl ? [] : [connectionProbePlugin(), scenarioLibraryPlugin()])],
  server: backendUrl ? { proxy: { "/api": { target: backendUrl, changeOrigin: true } } } : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
