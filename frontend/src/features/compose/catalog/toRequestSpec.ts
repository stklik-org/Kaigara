import {
  ExactGenerator,
  RandomizedGenerator,
  RequestSpec,
  type ParameterBinding,
  type RequestIdPoolData,
  type RequestOperation,
  type RequestTargetEntity,
} from "@kaigara/shared-types";
import { requestTemplate } from "./catalog";
import { engineFallbackFor, formatBytes, sampleOf, strategyDef } from "./resolve";
import { idtaTemplatesOrEmpty } from "./templateIndex";
import type { RequestTemplate } from "./types";

/**
 * The single seam between the catalogue and the metamodel.
 *
 * A catalogue pick has to become a `RequestSpec`, because that is what the Code view shows, what
 * `POST /api/runs` accepts and what the engine compiles. `operation`/`target`/`weight`/`generator`
 * stay the executable truth; `templateId`/`bindings` ride along so the editor can reopen the pick
 * and a later compiler can act on the detail the four-way mapping cannot express.
 *
 * Keeping the conversion in one file is what lets the catalogue describe endpoints the engine
 * cannot issue yet — see {@link engineGaps}, which says out loud what is lost on the way.
 */

const TARGET_ENTITY: Record<RequestTemplate["target"], RequestTargetEntity> = {
  aas: "shell",
  submodel: "submodel",
  // A composite starts by addressing a shell; its submodel steps hang off that.
  both: "shell",
};

/** Rough serialized size of an instance of one IDTA template — used only to give the engine's
 *  randomised payload a realistic size until it can instantiate the template itself. */
function estimateTemplateBytes(family: string): number {
  const template = idtaTemplatesOrEmpty().find((candidate) => candidate.family === family);
  return template ? Math.max(256, template.elements * 96) : 1024;
}

function generatorFor(template: RequestTemplate, bindings: Record<string, ParameterBinding>) {
  for (const parameter of template.parameters ?? []) {
    if (parameter.type !== "payload-template") continue;
    const binding = bindings[parameter.id];
    const config = binding?.config ?? {};
    switch (binding?.strategy) {
      case "custom-json":
        return new ExactGenerator({ value: typeof config.json === "string" ? config.json : "{}" });
      case "size-target":
        return new RandomizedGenerator({ sizeBytes: typeof config.bytes === "number" ? config.bytes : 4096 });
      case "idta-template":
        return new RandomizedGenerator({
          sizeBytes: estimateTemplateBytes(typeof config.family === "string" ? config.family : ""),
        });
      default:
        return RandomizedGenerator.createDefault();
    }
  }
  return RandomizedGenerator.createDefault();
}

/** Operations that actually address an entity by identifier. A create mints its own and a query
 *  pages a collection, so an id pool on either would be a setting nothing consults — the metamodel
 *  validator warns about exactly that, and there is no reason to author it in the first place. */
const ID_ADDRESSING: readonly string[] = ["read", "update", "delete"];

/**
 * Lowers a "From server" identifier binding into the one executable field the engine reads.
 *
 * This is the only place a *binding* becomes behaviour rather than provenance, and it is
 * deliberately narrow: the engine needs to know it must harvest before the load, and how far to
 * page. Everything else about the binding stays descriptive.
 */
function idPoolFor(
  template: RequestTemplate,
  bindings: Record<string, ParameterBinding>,
): RequestIdPoolData | undefined {
  if (!ID_ADDRESSING.includes(template.operation)) return undefined;

  for (const parameter of template.parameters ?? []) {
    if (!parameter.type.endsWith("identifier") || !parameter.bindsTo.startsWith("path.")) continue;
    const binding = bindings[parameter.id];
    if (binding?.strategy !== "from-server") continue;

    const config = binding.config ?? {};
    return {
      source: "server",
      ...(typeof config.maxIds === "number" ? { maxIds: config.maxIds } : {}),
    };
  }
  return undefined;
}

let sequence = 0;

export function newRequestId(templateId: string): string {
  sequence += 1;
  return `${templateId}-${Date.now().toString(36)}-${sequence}`;
}

export function toRequestSpec(
  template: RequestTemplate,
  bindings: Record<string, ParameterBinding>,
  weight: number,
  id = newRequestId(template.id),
): RequestSpec {
  const idPool = idPoolFor(template, bindings);
  return new RequestSpec({
    id,
    operation: template.operation as RequestOperation,
    target: TARGET_ENTITY[template.target],
    weight,
    generator: generatorFor(template, bindings),
    templateId: template.id,
    bindings,
    ...(idPool ? { idPool } : {}),
  });
}

/**
 * What the engine does *not* do with this pick today, in the user's words.
 *
 * Every line is derived from the same facts the backend uses (`describeOperation`'s table and the
 * generator kinds), so this cannot quietly drift into a lie. An empty list means the request runs
 * exactly as described.
 */
export function engineGaps(template: RequestTemplate, bindings: Record<string, ParameterBinding>): string[] {
  const gaps: string[] = [];
  const target = TARGET_ENTITY[template.target];

  if (template.kind === "composite") {
    gaps.push("Sequences are not compiled yet — each step would have to be added as its own request.");
    return gaps;
  }
  if (template.execution === "authoring") {
    gaps.push(
      `Issues ${engineFallbackFor(template.operation as RequestOperation, target)} instead of ` +
        `${template.endpoint?.method} ${template.endpoint?.path}.`,
    );
  }

  for (const parameter of template.parameters ?? []) {
    const binding = bindings[parameter.id];
    const strategy = strategyDef(parameter, binding?.strategy);
    if (!binding || !strategy) continue;

    if (parameter.type.endsWith("identifier") && parameter.bindsTo.startsWith("path.")) {
      const honoured =
        binding.strategy === "created-in-scenario" ||
        (binding.strategy === "from-server" && ID_ADDRESSING.includes(template.operation));
      if (!honoured) {
        gaps.push(
          `Draws the identifier from the pool this run created, falling back to ids found on the ` +
            `target — not "${strategy.label.toLowerCase()}".`,
        );
      }
    }
    if (parameter.type === "payload-template" && binding.strategy === "idta-template") {
      const family = typeof binding.config?.family === "string" ? binding.config.family : "the template";
      gaps.push(
        `Sends a randomised ${target} of about ${formatBytes(estimateTemplateBytes(family))} rather than a ` +
          `${family} instance.`,
      );
    }
    if (parameter.type === "attachment" && binding.strategy !== "none") {
      gaps.push("Uploads no file — attachment traffic is not generated yet.");
    }
    if (parameter.type === "query-condition") {
      gaps.push(`The condition is recorded but not sent; the engine pages the collection instead.`);
    }
    if (parameter.type === "page-size" && sampleOf(parameter, binding) !== "limit=20") {
      gaps.push("Pages at the engine's fixed limit of 20.");
    }
    if (parameter.type === "idshort-path") {
      gaps.push("Addresses the whole entity; the element path is recorded but not used.");
    }
  }

  return [...new Set(gaps)];
}

/** The editor's view of an existing spec: the pick it was made from, if it was made from one. */
export function draftFromSpec(spec: RequestSpec): {
  template: RequestTemplate | undefined;
  bindings: Record<string, ParameterBinding>;
} {
  const template = spec.templateId ? requestTemplate(spec.templateId) : undefined;
  return { template, bindings: spec.bindings ?? {} };
}
