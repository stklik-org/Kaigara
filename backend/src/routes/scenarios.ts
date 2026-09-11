/**
 * HTTP surface for the scenario library (`src/scenarios/library.ts`).
 *
 * `GET /api/scenarios` is what the Load screen's library reads; `GET /api/scenarios/:id` hands
 * back one full scenario document, which the Compose screen then edits. Both serve a folder on
 * disk, so "add a scenario" is copying a file into it — no upload endpoint, no storage schema.
 * Running one without going through the frontend is `POST /api/runs/scenario`, which takes either
 * an id from here or a document of your own.
 */

import type { FastifyInstance } from "fastify";

import { ScenarioFileError } from "@kaigara/shared-types";
import { ScenarioNotFoundError, listScenarios, readScenario, scenarioLibraryDir } from "../scenarios/library.ts";
import { documented, errorResponse } from "./apiSchemas.ts";

export function registerScenarioRoutes(app: FastifyInstance): void {
  app.get(
    "/api/scenarios",
    documented({
      tags: ["scenarios"],
      summary: "List the scenario library",
      description:
        "Every `.json` file in the library folder (`backend/scenarios/`, or `KAIGARA_SCENARIOS_DIR`). Files that fail to parse are listed *with their issues* rather than omitted — \"my scenario is missing\" is a worse answer than a named offending property.",
      response: {
        200: {
          description: "The folder that was read, and one entry per file in it.",
          type: "object",
          properties: {
            directory: { type: "string", description: "Which folder was read — handy when `KAIGARA_SCENARIOS_DIR` is set." },
            entries: { type: "array", items: { $ref: "#/components/schemas/ScenarioLibraryEntry" } },
          },
        },
      },
    }),
    async () => listScenarios(),
  );

  app.get<{ Params: { id: string } }>(
    "/api/scenarios/:id",
    documented({
      tags: ["scenarios"],
      summary: "One scenario document",
      description: "The file's contents, parsed and re-serialized. `phases.method` is the timeline `POST /api/runs` takes.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "The file stem, e.g. `shape-showcase`.", examples: ["shape-showcase"] },
        },
      },
      response: {
        200: { description: "The scenario.", $ref: "#/components/schemas/ScenarioDocument" },
        404: errorResponse("No such file in the library folder."),
        422: errorResponse("The file exists but is not a usable scenario; `issues` lists every offending path."),
      },
    }),
    async (request, reply) => {
      try {
        return await readScenario(request.params.id);
      } catch (error) {
        if (error instanceof ScenarioNotFoundError) {
          return reply.code(404).send({ error: error.message, directory: scenarioLibraryDir() });
        }
        if (error instanceof ScenarioFileError) {
          // 422, not 500: the folder is user-owned, so an unusable file is bad input rather than a
          // server fault, and the issue list is what lets the Load screen point at the offence.
          return reply.code(422).send({ error: error.message, issues: error.issues });
        }
        throw error;
      }
    },
  );
}
