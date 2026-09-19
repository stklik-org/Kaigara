import type { ParameterBinding, RequestOperation, RequestTargetEntity } from "@kaigara/shared-types";
import { parameterType } from "./catalog";
import { idtaTemplatesOrEmpty } from "./templateIndex";
import type { IdtaTemplate, JsonSchemaProperty, RequestTemplate, Strategy, TemplateParameter } from "./types";

/**
 * Everything the payload editor computes from a template plus its bindings — resolved URLs, sample
 * values, expected status codes. Pure and DOM-free on purpose: the panels render what these
 * return, and a future plan compiler can call the same functions.
 */

/** The strategies a card allows for one parameter: the type's list, narrowed by the card's own
 *  allow-list. Falls back to the full list if the allow-list matches nothing, so a stale card
 *  degrades to "too many options" rather than "no options". */
export function strategiesFor(parameter: TemplateParameter): Strategy[] {
  const all = parameterType(parameter.type)?.strategies ?? [];
  if (!parameter.strategies) return all;
  const narrowed = all.filter((strategy) => parameter.strategies?.includes(strategy.id));
  return narrowed.length > 0 ? narrowed : all;
}

export function strategyDef(parameter: TemplateParameter, id: string | undefined): Strategy | undefined {
  const strategies = strategiesFor(parameter);
  return strategies.find((strategy) => strategy.id === id) ?? strategies[0];
}

export function defaultStrategyId(parameter: TemplateParameter): string {
  const allowed = strategiesFor(parameter).map((strategy) => strategy.id);
  const wanted = parameter.default ?? parameterType(parameter.type)?.default;
  return wanted && allowed.includes(wanted) ? wanted : (allowed[0] ?? "");
}

/** A config object seeded from the strategy's JSON Schema defaults — the schema is the only
 *  description of what a strategy needs, so adding a field to it is a data-only change. */
export function defaultConfig(strategy: Strategy | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(strategy?.schema?.properties ?? {})) {
    config[key] =
      spec.default !== undefined
        ? spec.default
        : spec.enum
          ? spec.enum[0]
          : spec.type === "boolean"
            ? false
            : spec.type === "integer" || spec.type === "number"
              ? 0
              : spec.type === "array"
                ? []
                : "";
  }
  return config;
}

export function initBindings(template: RequestTemplate): Record<string, ParameterBinding> {
  const bindings: Record<string, ParameterBinding> = {};
  for (const parameter of template.parameters ?? []) {
    const strategy = defaultStrategyId(parameter);
    // A card may seed the default strategy's config (e.g. open "Fixed" in sequence mode) — those
    // values win over the schema defaults, and only for the strategy the card opens on.
    bindings[parameter.id] = {
      strategy,
      config: { ...defaultConfig(strategyDef(parameter, strategy)), ...(parameter.config ?? {}) },
    };
  }
  return bindings;
}

/** Options for a field whose values come from live data rather than a fixed `enum`. */
export function optionsFor(
  spec: JsonSchemaProperty,
  family: string | undefined,
  templates: IdtaTemplate[] = idtaTemplatesOrEmpty(),
): { value: string; label: string }[] | null {
  if (spec["x-options-from"] === "idta-templates") {
    return templates.map((template) => ({
      value: template.family,
      label: `${template.family} · IDTA ${template.idta} v${template.version}`,
    }));
  }
  if (spec["x-options-from"] === "template-elements") {
    const template = templates.find((candidate) => candidate.family === family) ?? templates[0];
    return (template?.paths ?? []).map((element) => ({
      value: element.path,
      label: `${element.path} · ${element.modelType}${element.valueType ? ` ${element.valueType}` : ""}`,
    }));
  }
  if (spec.enum) return spec.enum.map((value) => ({ value: String(value), label: String(value) }));
  return null;
}

/** Which IDTA template a set of bindings is talking about — chosen by one field, read by another
 *  (picking Handover Documentation changes which element paths are on offer). */
export function selectedFamily(bindings: Record<string, ParameterBinding>): string | undefined {
  for (const binding of Object.values(bindings)) {
    const family = binding.config?.family;
    if (typeof family === "string" && family !== "") return family;
  }
  return undefined;
}

function selectedFamilies(config: Record<string, unknown> | undefined): string[] {
  return Array.isArray(config?.families) ? (config.families as unknown[]).filter((f): f is string => typeof f === "string") : [];
}

/** A sibling "count" parameter's min/max, if the template has one — "Create AAS + Submodels"'
 *  "Submodels per shell" is the only one today, but this reads any card shaped the same way. */
function countRange(
  template: RequestTemplate,
  bindings: Record<string, ParameterBinding>,
): { param: TemplateParameter; min: number; max: number } | undefined {
  const param = (template.parameters ?? []).find((candidate) => candidate.type === "count");
  if (!param) return undefined;
  const binding = bindings[param.id];
  if (binding?.strategy === "range") {
    return { param, min: Number(binding.config?.min ?? 0), max: Number(binding.config?.max ?? Infinity) };
  }
  if (binding?.strategy === "fixed") {
    const n = Number(binding.config?.n ?? 0);
    return { param, min: n, max: n };
  }
  return undefined;
}

/** The families an "idta-template" pick actually feeds into the generator: every one selected,
 *  unless a sibling "count" parameter's max is smaller — "Create AAS + Submodels" needs at most
 *  `max` per shell, so selecting more than that picks a random subset of that size rather than
 *  using all of them for every request. `Math.random()` matches how every other "chosen per
 *  request" value in this codebase is randomised (see `toRequestSpec.ts`'s own doc comments) —
 *  this only has to be *a* legal subset each time it is computed, not a stable one. */
export function templateFamiliesFor(template: RequestTemplate, bindings: Record<string, ParameterBinding>, binding: ParameterBinding | undefined): string[] {
  const families = selectedFamilies(binding?.config);
  const range = countRange(template, bindings);
  if (!range || families.length <= range.max) return families;

  const pool = [...families];
  for (let i = pool.length - 1; i > pool.length - 1 - range.max; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(pool.length - range.max);
}

/** Whether a payload pick's selected templates satisfy a sibling "count" parameter's minimum —
 *  "Create AAS + Submodels" needs at least `min` distinct templates so every submodel a shell asks
 *  for (down to the smallest count in its range) can draw from a real selection rather than always
 *  repeating whatever was picked. Returns the problem to show, or `undefined` when it's fine. */
export function templateSelectionIssue(template: RequestTemplate, bindings: Record<string, ParameterBinding>): string | undefined {
  const payloadParam = (template.parameters ?? []).find((candidate) => candidate.type === "payload-template");
  if (!payloadParam) return undefined;
  const binding = bindings[payloadParam.id];
  if (binding?.strategy !== "idta-template") return undefined;

  const range = countRange(template, bindings);
  if (!range) return undefined;

  const families = selectedFamilies(binding.config);
  if (families.length < range.min) {
    return `"${payloadParam.label}" needs at least ${range.min} selected template${range.min === 1 ? "" : "s"} — "${range.param.label}" can ask for up to ${range.min} per shell.`;
  }
  return undefined;
}

/** One concrete example of what a bound parameter produces — the chips in the composition list and
 *  the dialog's preview are both this. */
export function sampleOf(parameter: TemplateParameter, binding: ParameterBinding | undefined): string {
  const strategy = strategyDef(parameter, binding?.strategy);
  const config = binding?.config ?? {};
  const text = (key: string): string => (typeof config[key] === "string" ? (config[key] as string) : "");
  const num = (key: string, fallback: number): number =>
    typeof config[key] === "number" ? (config[key] as number) : fallback;

  switch (binding?.strategy) {
    case "fixed":
      return config.mode === "sequence"
        ? text("format").replace("%06d", "000417").replace("%04d", "0417").replace("%d", "417") ||
            strategy?.sample ||
            ""
        : text("value") || text("path") || text("prefix") || strategy?.sample || "";
    case "from-template":
      return text("path") || strategy?.sample || "";
    case "random-number":
      return String(Math.round((num("min", 0) + num("max", 1000)) / 2));
    case "one-of":
      return text("values").split("\n").filter(Boolean)[0] || strategy?.sample || "";
    case "idta-template": {
      const families = Array.isArray(config.families)
        ? (config.families as unknown[]).filter((f): f is string => typeof f === "string")
        : [];
      const templates = idtaTemplatesOrEmpty().filter((candidate) => families.includes(candidate.family));
      if (templates.length === 0) return strategy?.sample ?? "";
      if (templates.length === 1) return `${templates[0].idShort} · ${templates[0].elements} elements`;
      return `${templates.length} templates, one chosen per request`;
    }
    case "by-semantic-id": {
      const template = idtaTemplatesOrEmpty().find((candidate) => candidate.family === text("family"));
      if (!template) return strategy?.sample ?? "";
      return `semanticId = ${template.semanticId}`;
    }
    case "by-property-value":
      return `${text("path")} ${text("operator")} ${text("value")}`;
    case "by-idshort-prefix":
      return `idShort starts with "${text("prefix")}"`;
    case "size-target":
      return formatBytes(num("bytes", 0));
    case "synthesised":
      return `${text("format").toUpperCase()} ${formatBytes(num("minBytes", 0))}–${formatBytes(num("maxBytes", 0))}`;
    case "from-folder":
      return text("folder");
    case "range":
      return `${num("min", 0)}–${num("max", 0)}`;
    default:
      return strategy?.sample ?? strategy?.label ?? "";
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1).replace(/\.0$/, "")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The endpoint's expected status codes, unless a chosen strategy overrides them — which is how
 *  "non-existing" turns a read into a 404 test without any special-casing in the UI. */
export function expectedOf(template: RequestTemplate, bindings: Record<string, ParameterBinding>): number[] {
  let expect = template.endpoint?.expect ?? [];
  for (const parameter of template.parameters ?? []) {
    const strategy = strategyDef(parameter, bindings[parameter.id]?.strategy);
    if (strategy?.expect) expect = strategy.expect;
  }
  return expect;
}

/** IDTA-01002 puts identifiers in paths base64url-encoded (they are IRIs); idShortPaths go in as
 *  written. Same rule as `backend/src/timeline/aasOperations.ts`, so the preview is honest about
 *  what the engine will send. */
export function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ResolvedRequest {
  method: string;
  path: string;
  expect: number[];
  body: string | null;
  /** `token = raw value` for every identifier the path carries base64url-encoded. */
  encoded: string[];
  steps: string[];
}

export function resolveRequest(
  template: RequestTemplate,
  bindings: Record<string, ParameterBinding>,
): ResolvedRequest {
  if (template.kind === "composite") {
    return {
      method: `×${template.steps?.length ?? 0}`,
      path: `${template.steps?.length ?? 0} steps, in order`,
      expect: [],
      body: null,
      encoded: [],
      steps: (template.steps ?? []).map((step) => step.ref),
    };
  }

  const endpoint = template.endpoint;
  if (!endpoint) return { method: "?", path: "", expect: [], body: null, encoded: [], steps: [] };

  let path = endpoint.path;
  const query: string[] = [];
  const encoded: string[] = [];

  for (const parameter of template.parameters ?? []) {
    const value = sampleOf(parameter, bindings[parameter.id]);
    if (parameter.bindsTo.startsWith("path.")) {
      const token = parameter.bindsTo.slice("path.".length);
      const isIdentifier = parameter.type.endsWith("identifier");
      if (isIdentifier && value) encoded.push(`${token} = ${value}`);
      path = path.replace(`{${token}}`, isIdentifier && value ? base64url(value) : value);
    }
    if (parameter.bindsTo.startsWith("query.")) {
      query.push(`${parameter.bindsTo.slice("query.".length)}=${value.replace(/^limit=/, "")}`);
    }
  }

  for (const [key, token] of Object.entries(endpoint.query ?? {})) {
    if (query.some((entry) => entry.startsWith(`${key}=`))) continue;
    const parameter = (template.parameters ?? []).find((candidate) => `{${candidate.id}}` === token);
    if (parameter) {
      query.push(`${key}=${sampleOf(parameter, bindings[parameter.id]).replace(/^limit=/, "")}`);
    }
  }

  return {
    method: endpoint.method,
    path: path + (query.length ? `?${query.join("&")}` : ""),
    expect: expectedOf(template, bindings),
    body: endpoint.body ? bodyPreview(template, bindings) : null,
    encoded,
    steps: [],
  };
}

/** Parameters whose value is a whole document rather than a field: showing their sample as a JSON
 *  string would misrepresent the body, so they are previewed as a comment describing what fills it. */
const DESCRIBED_IN_BODY = new Set(["payload-template", "attachment", "query-condition"]);

function bodyPreview(template: RequestTemplate, bindings: Record<string, ParameterBinding>): string {
  const lines: string[] = [];
  for (const parameter of template.parameters ?? []) {
    if (!parameter.bindsTo.startsWith("body")) continue;
    const sample = sampleOf(parameter, bindings[parameter.id]);
    const key = parameter.bindsTo === "body" ? parameter.id : parameter.bindsTo.slice("body.".length);
    if (DESCRIBED_IN_BODY.has(parameter.type)) {
      lines.push(parameter.bindsTo === "body" ? `  /* ${sample} */` : `  "${key}": { /* ${sample} */ }`);
      continue;
    }
    lines.push(`  "${key}": ${JSON.stringify(sample)}`);
  }
  return lines.length ? `{\n${lines.join(",\n")}\n}` : "{ … }";
}

/** What the engine actually issues for an `authoring` pattern — derived from the (operation ×
 *  target) table rather than restated per card, so it cannot drift from the backend. */
const ENGINE_CALL: Record<RequestOperation, (collection: string) => string> = {
  create: (collection) => `POST ${collection}`,
  read: (collection) => `GET ${collection}/{id}`,
  update: (collection) => `PUT ${collection}/{id}`,
  delete: (collection) => `DELETE ${collection}/{id}`,
  query: (collection) => `GET ${collection}?limit=20`,
};

export function engineFallbackFor(operation: RequestOperation, target: RequestTargetEntity): string {
  return ENGINE_CALL[operation](target === "shell" ? "/shells" : "/submodels");
}

/**
 * Keeps a config valid after one of its fields changed the options of another — picking a different
 * submodel template changes which element paths exist, and the previously chosen path may not be
 * one of them. Resetting to the first legal option beats silently sending a path the template does
 * not have.
 */
export function revalidateConfig(
  strategy: Strategy | undefined,
  config: Record<string, unknown>,
  templates: IdtaTemplate[],
): Record<string, unknown> {
  const next = { ...config };
  const family = typeof next.family === "string" ? next.family : undefined;
  for (const [key, spec] of Object.entries(strategy?.schema?.properties ?? {})) {
    if (!spec["x-options-from"]) continue;
    const options = optionsFor(spec, family, templates);
    if (options && options.length > 0 && !options.some((option) => option.value === String(next[key]))) {
      next[key] = options[0].value;
    }
  }
  return next;
}
