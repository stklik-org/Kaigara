/**
 * Writes `schema/load-timeline.schema.json` from the `loadTimelineSchema` constant in
 * `src/loadTimelineSchema.ts`, which is the single source of truth.
 *
 * The two used to be maintained by hand, and had already drifted: `Track.color` is emitted by
 * `Track.toJSON()` but was missing from a schema declaring `additionalProperties: false`, so
 * colouring a track made the Compose Code view show a spurious error on a document the app itself
 * had just produced. Generating the file removes that whole class of bug.
 *
 *   node scripts/emit-schema.ts            # rewrite the JSON file
 *   node scripts/emit-schema.ts --check    # exit 1 if it is out of date (for CI)
 *
 * Runs on plain `node` via its built-in TypeScript type stripping — `loadTimelineSchema.ts` has
 * no imports of its own, so there is no extensionless-specifier resolution to worry about here.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadTimelineSchema } from "../src/loadTimelineSchema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../schema/load-timeline.schema.json");
const serialized = `${JSON.stringify(loadTimelineSchema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error(`schema:check — ${target} is missing. Run: npm run schema:emit -w @kaigara/shared-types`);
    process.exit(1);
  }
  if (current !== serialized) {
    console.error(
      `schema:check — schema/load-timeline.schema.json is out of date with src/loadTimelineSchema.ts.\n` +
        `Run: npm run schema:emit -w @kaigara/shared-types`,
    );
    process.exit(1);
  }
  console.log("schema:check — schema/load-timeline.schema.json is up to date.");
} else {
  writeFileSync(target, serialized);
  console.log(`schema:emit — wrote ${target}`);
}
