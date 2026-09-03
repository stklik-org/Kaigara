/**
 * HTTP surface for the scenario library (`src/scenarios/library.ts`).
 *
 * `GET /api/scenarios` is what the Load screen's library reads; `GET /api/scenarios/:id` hands
 * back one full scenario document, which the Compose screen then edits. Both serve a folder on
 * disk, so "add a scenario" is copying a file into it — no upload endpoint, no storage schema.
 */

import type { FastifyInstance } from "fastify";

import { ScenarioFileError } from "@kaigara/shared-types";
import { ScenarioNotFoundError, listScenarios, readScenario, scenarioLibraryDir } from "../scenarios/library.ts";

export function registerScenarioRoutes(app: FastifyInstance): void {
  app.get("/api/scenarios", async () => listScenarios());

  app.get<{ Params: { id: string } }>("/api/scenarios/:id", async (request, reply) => {
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
  });
}
