import type { ParameterType, RequestTemplate } from "./types";

/**
 * Loads the catalogue folder. Adding a request pattern is dropping a JSON file into
 * `request-templates/`; adding a way to fill a parameter is one entry in a `parameter-types/`
 * file. Neither needs a code change, which is the whole point of the folder being data.
 *
 * `import.meta.glob` is resolved by Vite at build time, so there is no fetch, no loading state and
 * no build step of our own — and a malformed JSON file fails the build rather than the run.
 */
const templateModules = import.meta.glob<RequestTemplate>("./request-templates/*.json", {
  eager: true,
  import: "default",
});
const parameterTypeModules = import.meta.glob<ParameterType>("./parameter-types/*.json", {
  eager: true,
  import: "default",
});

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export const REQUEST_TEMPLATES: readonly RequestTemplate[] = sortById(Object.values(templateModules));
export const PARAMETER_TYPES: readonly ParameterType[] = sortById(Object.values(parameterTypeModules));

const templatesById = new Map(REQUEST_TEMPLATES.map((template) => [template.id, template]));
const parameterTypesById = new Map(PARAMETER_TYPES.map((type) => [type.id, type]));

export function requestTemplate(id: string): RequestTemplate | undefined {
  return templatesById.get(id);
}

export function parameterType(id: string): ParameterType | undefined {
  return parameterTypesById.get(id);
}

/**
 * Cross-file references the JSON cannot express: a card naming a parameter type, strategy or step
 * that does not exist. Reported rather than thrown — a typo in one card should not blank the whole
 * Compose screen — and surfaced in the catalogue panel's footer so it cannot go unnoticed.
 */
export function catalogIssues(): string[] {
  const issues: string[] = [];

  for (const template of REQUEST_TEMPLATES) {
    for (const parameter of template.parameters ?? []) {
      const type = parameterTypesById.get(parameter.type);
      if (!type) {
        issues.push(`${template.id}.${parameter.id}: unknown parameter type "${parameter.type}"`);
        continue;
      }
      const known = new Set(type.strategies.map((strategy) => strategy.id));
      for (const id of parameter.strategies ?? []) {
        if (!known.has(id)) issues.push(`${template.id}.${parameter.id}: unknown strategy "${id}"`);
      }
      if (parameter.default && !known.has(parameter.default)) {
        issues.push(`${template.id}.${parameter.id}: unknown default strategy "${parameter.default}"`);
      }
    }
    for (const step of template.steps ?? []) {
      if (!templatesById.has(step.ref)) issues.push(`${template.id}: step references unknown template "${step.ref}"`);
    }
  }

  return issues;
}
