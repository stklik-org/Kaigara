/**
 * The catalogue's own vocabulary: what a request *pattern* is, and how its parameters may be bound.
 *
 * Deliberately separate from `@kaigara/shared-types`' metamodel. The metamodel describes what a
 * scenario **is** (and what the engine executes); this describes what the user **picks from**. The
 * two meet in one place only — `toRequestSpec.ts` — so the catalogue can grow endpoints the engine
 * cannot issue yet without that leaking into the saved document's executable fields.
 */

export type CatalogOperation = "create" | "read" | "update" | "delete" | "query";

/** "both" is a composite that touches shells *and* submodels; it shows under either target pill. */
export type CatalogTarget = "aas" | "submodel" | "both";

/**
 * Whether the engine can issue this pattern's endpoint today.
 *  - `engine`    — `describeOperation()` maps it to exactly this call.
 *  - `authoring` — the pattern is richer than the (operation × target) table (element paths,
 *                  `$value`, `/attachment`, `$query`, sequences). It is recorded faithfully in the
 *                  document, and the engine issues the nearest call it knows. The UI says so
 *                  rather than pretending otherwise.
 */
export type ExecutionSupport = "engine" | "authoring";

/** The subset of JSON Schema the parameter dialog renders. Anything outside it is ignored rather
 *  than rejected — a strategy may carry keywords for a future validator. */
export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "object";
  title?: string;
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** Renders a multi-line input. Not standard JSON Schema; the only presentational hint here. */
  format?: "textarea";
  /** Options come from live data instead of a fixed `enum` — see `optionsFor` in resolve.ts. */
  "x-options-from"?: "idta-templates" | "template-elements";
  /** Show this field only while another field in the same strategy holds `equals` — e.g. the
   *  "Fixed" identifier's literal value shows only in `mode: "literal"`. Honoured by
   *  `SchemaFields.tsx`; a hidden field keeps its config value so toggling back restores it. */
  "x-show-when"?: { field: string; equals: string | number | boolean };
}

export interface StrategySchema {
  type: "object";
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
}

export interface Strategy {
  id: string;
  label: string;
  /** One sentence under the pills explaining what this produces. */
  hint?: string;
  /** A representative value, used when nothing better can be derived from the config. */
  sample?: string;
  /** Overrides the endpoint's expected status codes — this is how "non-existing" becomes a 404
   *  test without the UI knowing anything about negative testing. */
  expect?: number[];
  schema?: StrategySchema;
}

export interface ParameterType {
  id: string;
  title: string;
  description?: string;
  /** Strategy chosen when a card does not name one. */
  default?: string;
  appliesTo?: string[];
  strategies: Strategy[];
}

export interface TemplateParameter {
  id: string;
  label: string;
  /** A {@link ParameterType} id. */
  type: string;
  /** Where the resolved value goes: `path.<token>` | `query.<name>` | `body` | `body.<field>` |
   *  `steps[n]…` (composites only, not resolved yet). */
  bindsTo: string;
  /** Narrows the parameter type's strategies — "Create AAS" only offers "Fixed" for the identifier
   *  it is about to create. */
  strategies?: string[];
  default?: string;
  /** Seed values for the default strategy's config, merged over its schema defaults — lets a card
   *  open "Fixed" in `mode: "sequence"` without changing the strategy's own default. */
  config?: Record<string, unknown>;
  note?: string;
}

export interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  expect: number[];
  body?: boolean;
  query?: Record<string, string>;
}

export interface CompositeStep {
  ref: string;
  repeatWith?: string;
  bind?: Record<string, string>;
  capture?: Record<string, string>;
  note?: string;
}

export interface RequestTemplate {
  id: string;
  title: string;
  operation: CatalogOperation;
  target: CatalogTarget;
  execution: ExecutionSupport;
  summary: string;
  kind?: "request" | "composite";
  endpoint?: Endpoint;
  steps?: CompositeStep[];
  parameters?: TemplateParameter[];
  defaults?: { weight?: number };
  captures?: Record<string, string>;
  consumesPool?: boolean;
  /** A caveat worth showing in the dialog (e.g. "not every server implements the Query API"). */
  notes?: string;
}

/** One published IDTA submodel template, from `templates.index.json` — generated out of
 *  `frontend/submodel-templates`, so the dropdowns offer real templates and real idShortPaths. */
export interface IdtaTemplate {
  family: string;
  idta: string;
  version: string;
  idShort: string;
  semanticId: string;
  elements: number;
  paths: { path: string; modelType: string; valueType?: string }[];
}
