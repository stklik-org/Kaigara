/**
 * Swagger UI over the orchestrator's HTTP API.
 *
 * The point is to make the backend usable without the frontend: open `/swagger`, paste (or name) a
 * scenario, point it at an AAS server, press Execute. That is the fastest way to exercise the
 * timeline → plan → k6 pipeline while the Compose screen is still moving, and it is how you check
 * a hand-written scenario file before dropping it into `backend/scenarios/`.
 *
 * The spec is generated from the routes' own schemas rather than written alongside them, so it
 * cannot describe an endpoint that no longer exists. See `apiSchemas.ts` for why those schemas
 * document without validating.
 */

import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { componentSchemas } from "./apiSchemas.ts";

export const SWAGGER_ROUTE_PREFIX = "/swagger";

/**
 * Must be registered *before* the routes it documents: `@fastify/swagger` collects route schemas
 * as they are added, and anything registered earlier is invisible to it.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Kaigara orchestrator API",
        description:
          [
            "Benchmark orchestration for AAS servers. Three slices are real: the connection probe, the",
            "scenario library, and timeline execution. The preparation/correctness phases and run history",
            "are not implemented — see `backend/README.md`.",
            "",
            "**To run a benchmark from here:**",
            "",
            "1. Start a target — `npm run stub-aas -w backend` gives you one on `http://127.0.0.1:8081/api/v3`.",
            "2. `GET /api/engines` — confirm k6 is installed, before a missing binary looks like a failed run.",
            "3. `POST /api/runs/scenario` with `{ \"scenarioId\": \"shape-showcase\", \"target\": { … } }`, or with",
            "   your own document under `scenario`. Add `\"dryRun\": true` to compile and inspect the plan",
            "   without sending a single request.",
            "4. `GET /api/runs/{id}` to follow it, `GET /api/runs/{id}/artifacts/script.js` to read exactly",
            "   what was executed.",
            "",
            "Runs are held in memory and do not survive a restart.",
          ].join("\n"),
        version: "0.0.0",
      },
      tags: [
        { name: "runs", description: "Compile and execute a timeline, and follow the result." },
        { name: "scenarios", description: "The scenario library: a folder of documents, served as-is." },
        { name: "connections", description: "Reachability and conformance probing of a target AAS server." },
        { name: "engines", description: "Which engine adapters this build can actually run." },
        { name: "meta", description: "Service health." },
      ],
      components: { schemas: componentSchemas },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: SWAGGER_ROUTE_PREFIX,
    theme: {
      css: [
        {
          filename: "kaigara.css",
          // Swagger UI gives inline `code` a bigger font than its line box allows, so any
          // description that wraps — every one of the longer ones here — renders as overlapping
          // lines. Endpoint descriptions are the whole value of this page; they have to be legible.
          content: `
            .swagger-ui .renderedMarkdown p,
            .swagger-ui .renderedMarkdown li { line-height: 1.7; }
            .swagger-ui .renderedMarkdown code { line-height: 1.4; }
            .swagger-ui .renderedMarkdown ol,
            .swagger-ui .renderedMarkdown ul { padding-left: 1.5em; }
            .swagger-ui .renderedMarkdown li { margin-bottom: .25em; }
          `,
        },
      ],
    },
    uiConfig: {
      // The API is small enough to read whole, and "play around with it" means seeing everything.
      docExpansion: "list",
      deepLinking: true,
      // Left as-is a request runs until the engine finishes; a benchmark legitimately takes minutes.
      tryItOutEnabled: true,
    },
  });
}
