/**
 * The script templates: one small, standalone k6 file per planned script, picked by operation —
 * read (by identifier, or a collection query), create, update, delete — plus the thin `main.js`
 * that puts them on the timeline (ADR 0005).
 *
 * Every generated file has the same five parts, the pattern `sink/k6-tmp/03-delete-aas.js` shows by
 * hand:
 *   1. constants — `BASE_URL`, headers, metric tags, and the literal identifier list `IDS`;
 *   2. `EXECUTOR` / `options` — when and how fast, so the file also runs on its own;
 *   3. `bodyFor(id)` — create/update only: the payload for one identifier;
 *   4. `requestFor(i)` — the generator: request number `i` of this script. `i` is k6's global
 *      iteration number for the scenario, so every VU draws a different one and a create never
 *      mints the same identifier twice — which a per-VU `function*` generator could not promise;
 *   5. `run()` — send it and check the status.
 *
 * Nothing here decides anything: rates, shares and which identifiers exist when were all settled in
 * `compileTimeline.ts`. These functions only turn a `PlannedScript` into text — and nothing in this
 * file imports k6; it only writes what k6 will later read (k6 is AGPL-3.0 and runs strictly as an
 * external subprocess, proposal sections 3.1 and 12).
 *
 * Target headers — an Authorization bearer token, typically — are never written into a file: the
 * scripts read them from the `KAIGARA_HEADERS` environment variable, which the adapter sets on the
 * k6 process. The generated files are archived to disk and served back over the API.
 */

import { COLLECTION_PATH } from "../../timeline/aasOperations.ts";
import {
  describeExecutor,
  planScripts,
  secondsToK6Duration,
  type K6Plan,
  type PlannedBody,
  type PlannedLoad,
  type PlannedScript,
} from "./k6Plan.ts";

/** Above this many identifiers a list is held in a k6 `SharedArray` — one copy for every VU —
 *  instead of a plain array each VU parses its own copy of. A purge of 100 000 entities must not
 *  multiply its identifier list by the VU count. */
export const SHARED_ARRAY_THRESHOLD = 1000;

/** Environment variable the scripts read target headers from (a JSON object). */
export const HEADERS_ENV = "KAIGARA_HEADERS";

/** File k6's `handleSummary` in `main.js` writes, relative to the directory k6 runs in. */
export const SUMMARY_FILE = "summary.json";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INLINE_WIDTH = 72;

/** Prints a JSON-compatible value as a JavaScript literal the way a person would write it: bare
 *  keys where they are identifiers, short objects and arrays on one line, longer ones one entry per
 *  line. The generated files are read by people, so they should look hand-written. */
function toJs(value: unknown, level = 0): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const pad = "  ".repeat(level);
  const inner = "  ".repeat(level + 1);
  const parts = Array.isArray(value)
    ? value.map((item) => toJs(item, level + 1))
    : Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${toJs(item, level + 1)}`,
      );
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (parts.length === 0) return `${open}${close}`;

  const inline = Array.isArray(value) ? `[${parts.join(", ")}]` : `{ ${parts.join(", ")} }`;
  if (inline.length <= INLINE_WIDTH && !inline.includes("\n")) return inline;
  return `${open}\n${parts.map((part) => `${inner}${part},`).join("\n")}\n${pad}${close}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `/shells/{id}` + `{limit: "20"}` → the body of a JS template literal that builds the URL. */
function urlExpression(script: PlannedScript): string {
  const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const [before, after] = script.pathTemplate.split("{id}");
  let path = escape(before);
  if (after !== undefined) path += '${encoding.b64encode(id, "rawurl")}' + escape(after);

  const keys = Object.keys(script.query);
  if (keys.length > 0) {
    path += `?${keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(script.query[key])}`).join("&")}`;
  }
  return `\`\${BASE_URL}${path}\``;
}

/** How the path reads in prose and in the schedule: `GET /shells/{id}`, `GET /shells?limit=20`. */
export function requestLine(script: PlannedScript): string {
  const keys = Object.keys(script.query);
  const query = keys.length > 0 ? `?${keys.map((key) => `${key}=${script.query[key]}`).join("&")}` : "";
  return `${script.method} ${script.pathTemplate}${query}`;
}

/** One sentence on what each iteration does, for the file header. */
function whatItDoes(script: PlannedScript): string {
  const entity = script.target;
  switch (script.identifiers.use) {
    case "mint":
      return `one new ${entity} per iteration: iteration i creates IDS[i]`;
    case "each-once":
      return `iteration i deletes IDS[i], each identifier exactly once`;
    case "cycle":
      return `iteration i ${script.operation === "read" ? "reads" : "updates"} IDS[i % IDS.length]`;
    case "none":
      return script.operation === "create" ? "the same Exact body every iteration" : "a collection read, no identifier";
  }
}

function header(script: PlannedScript, load: PlannedLoad): string {
  return [
    "// GENERATED BY KAIGARA — do not edit.",
    "//",
    `// ${script.file} — ${load.label}`,
    `//   sends:  ${requestLine(script)} — ${whatItDoes(script)}`,
    `//   runs:   ${describeExecutor(script.executor, load.shapeKind)} (main.js starts it at +${secondsToK6Duration(script.startSeconds)})`,
    `//   alone:  k6 run ${script.file}`,
    `//           Target headers come from ${HEADERS_ENV}, a JSON object — never from this file:`,
    `//           ${HEADERS_ENV}='{"authorization":"Bearer …"}' k6 run ${script.file}`,
  ].join("\n");
}

function imports(script: PlannedScript): string {
  const addressesId = script.pathTemplate.includes("{id}");
  const canSkip = script.identifiers.use !== "none";
  const shared = script.identifiers.list.length > SHARED_ARRAY_THRESHOLD;
  return [
    'import http from "k6/http";',
    'import { check } from "k6";',
    addressesId ? 'import encoding from "k6/encoding";' : null,
    'import execution from "k6/execution";',
    canSkip ? 'import { Counter } from "k6/metrics";' : null,
    shared ? 'import { SharedArray } from "k6/data";' : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function constants(script: PlannedScript, load: PlannedLoad, plan: K6Plan): string {
  const sendsBody = script.body.kind !== "none";
  const baseHeaders = sendsBody
    ? '{ accept: "application/json", "content-type": "application/json" }'
    : '{ accept: "application/json" }';
  const tags = { load: load.key, track: load.trackId, op: script.operation, target: script.target, script: script.key };

  return [
    `const BASE_URL = ${JSON.stringify(plan.target.baseUrl)};`,
    `// Kaigara passes the target's own headers (an Authorization token, say) in through the`,
    `// environment, so no credential is ever written into this file.`,
    `const HEADERS = Object.assign(${baseHeaders}, JSON.parse(__ENV.${HEADERS_ENV} || "{}"));`,
    `// Metric tags: how the orchestrator attributes each response to its load and request type.`,
    `const TAGS = ${toJs(tags)};`,
    `const EXPECTED_STATUS = ${toJs(script.expectStatus)};`,
    `const PARAMS = {`,
    `  headers: HEADERS,`,
    `  tags: TAGS,`,
    `  timeout: ${JSON.stringify(secondsToK6Duration(plan.target.timeoutSeconds))},`,
    `  // Makes k6's own "failed request" metric agree with EXPECTED_STATUS, not its default 2xx/3xx.`,
    `  responseCallback: http.expectedStatuses(...EXPECTED_STATUS),`,
    `};`,
  ].join("\n");
}

/** The literal identifier list, with a comment saying what it is and where it came from. */
function identifierList(script: PlannedScript): string | null {
  const { use, list, note } = script.identifiers;
  if (use === "none") return null;

  const entity = script.target;
  const verb = use === "mint" ? "creates, in order" : use === "each-once" ? "deletes, each exactly once" : "addresses, polled in order";
  const comment =
    list.length === 0
      ? [
          `// No ${entity} is known to exist when this script starts (see the compile warnings), so every`,
          `// iteration is skipped and counted under kaigara_skipped_no_id rather than sent.`,
        ]
      : [`// The ${plural(list.length, entity)} this script ${verb} — ${note}.`];

  const entries = list.map((id) => `  ${JSON.stringify(id)},`).join("\n");
  const literal = list.length === 0 ? "[]" : `[\n${entries}\n]`;

  if (list.length > SHARED_ARRAY_THRESHOLD) {
    comment.push(`// Held in a SharedArray: one copy for every VU, rather than one each.`);
    const shared = `[\n${list.map((id) => `    ${JSON.stringify(id)},`).join("\n")}\n  ]`;
    return `${comment.join("\n")}\nconst IDS = new SharedArray(${JSON.stringify(script.key)}, () => ${shared});`;
  }
  return `${comment.join("\n")}\nconst IDS = ${literal};`;
}

function executorBlock(script: PlannedScript): string {
  return [
    "// When and how fast: one k6 executor. main.js schedules this same EXECUTOR at the load's offset;",
    "// run on its own, the file starts it immediately.",
    `export const EXECUTOR = ${toJs(script.executor)};`,
    "",
    `export const options = { scenarios: { ${script.key}: EXECUTOR } };`,
  ].join("\n");
}

const RANDOM_SHELL = String.raw`function bodyFor(id) {
  const shell = {
    modelType: "AssetAdministrationShell",
    id: id,
    idShort: "shell_" + id.replace(/[^a-zA-Z0-9]/g, "_").slice(-48),
    assetInformation: { assetKind: "Instance", globalAssetId: id.replace("/shell/", "/asset/") },
  };
  const padding = SIZE_BYTES - JSON.stringify(shell).length;
  if (padding > 0) shell.description = [{ language: "en", text: "x".repeat(padding) }];
  return JSON.stringify(shell);
}`;

const RANDOM_SUBMODEL = String.raw`function bodyFor(id) {
  const submodel = {
    modelType: "Submodel",
    id: id,
    idShort: "submodel_" + id.replace(/[^a-zA-Z0-9]/g, "_").slice(-48),
    submodelElements: [
      { modelType: "Property", idShort: "generatedAt", valueType: "xs:string", value: new Date().toISOString() },
    ],
  };
  const padding = SIZE_BYTES - JSON.stringify(submodel).length;
  if (padding > 0) {
    submodel.submodelElements.push({ modelType: "Property", idShort: "payload", valueType: "xs:string", value: "x".repeat(padding) });
  }
  return JSON.stringify(submodel);
}`;

const MUTATE = String.raw`// Rewrites about MUTATION_RATE_PERCENT of the leaf values, keeping the structure intact — "mutate"
// sits between Exact (no variation) and Randomized (no fixed structure).
function mutate(node) {
  if (Array.isArray(node)) {
    node.forEach(mutate);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value !== null && typeof value === "object") {
      mutate(value);
    } else if (Math.random() * 100 < MUTATION_RATE_PERCENT) {
      if (typeof value === "number") node[key] = value + Math.round(Math.random() * 100);
      else if (typeof value === "string") node[key] = value + "-" + Math.random().toString(36).slice(2, 8);
    }
  }
}

function bodyFor(id) {
  const payload = JSON.parse(JSON.stringify(BASE));
  mutate(payload);
  // A PUT whose body names a different id than its URL is rejected by conformant servers.
  payload.id = id;
  return JSON.stringify(payload);
}`;

/** `bodyFor(id)` (or the verbatim `BODY`) for a create or update, by generator kind. */
function bodyBlock(script: PlannedScript): string | null {
  const body: PlannedBody = script.body;
  switch (body.kind) {
    case "none":
      return null;
    case "exact":
      return [
        "// The authored Exact body, sent verbatim on every iteration — its own identifier included,",
        "// which is what makes Exact the way to author a deliberately invalid or conflicting request.",
        `const BODY = ${JSON.stringify(body.value)};`,
      ].join("\n");
    case "randomized":
      return [
        `// The payload for one identifier: a minimal IDTA-01001 ${script.target}, padded to ~${body.sizeBytes} bytes. A real`,
        "// entity rather than an opaque blob, so a server that validates its input measures acceptance.",
        `const SIZE_BYTES = ${body.sizeBytes};`,
        "",
        script.target === "shell" ? RANDOM_SHELL : RANDOM_SUBMODEL,
      ].join("\n");
    case "mutate":
      return [
        `// The payload for one identifier: this authored base, ~${body.mutationRatePercent}% of its values rewritten per request.`,
        `const BASE = ${toJs(JSON.parse(body.baseValue))};`,
        `const MUTATION_RATE_PERCENT = ${body.mutationRatePercent};`,
        "",
        MUTATE,
      ].join("\n");
  }
}

/** The generator: `requestFor(i)` → `{ method, url, body }`, or `null` when there is nothing to
 *  address for that iteration. One shape per identifier use. */
function generatorBlock(script: PlannedScript): string {
  const url = urlExpression(script);
  const body = script.body.kind === "none" ? "null" : script.body.kind === "exact" ? "BODY" : "bodyFor(id)";
  const send = `return { method: ${JSON.stringify(script.method)}, url: ${url}, body: ${body} };`;
  const doc = "// The generator: request number i of this script, i = k6's iteration number for this scenario across";

  switch (script.identifiers.use) {
    case "mint":
      return [
        doc,
        "// every VU. Returns null past the end of IDS — more iterations than identifiers were minted for.",
        "function requestFor(i) {",
        "  if (i >= IDS.length) return null;",
        "  const id = IDS[i];",
        `  ${send}`,
        "}",
      ].join("\n");
    case "each-once":
      return [
        doc,
        "// every VU. Returns null past the end of IDS — there is nothing left to delete.",
        "function requestFor(i) {",
        "  if (i >= IDS.length) return null;",
        "  const id = IDS[i];",
        `  ${send}`,
        "}",
      ].join("\n");
    case "cycle":
      return [
        doc,
        "// every VU. Cycles through IDS; returns null only if there is nothing to address at all.",
        "function requestFor(i) {",
        "  if (IDS.length === 0) return null;",
        "  const id = IDS[i % IDS.length];",
        `  ${send}`,
        "}",
      ].join("\n");
    case "none":
      return [doc, "// every VU. This request addresses no identifier, so every iteration is the same.", "function requestFor(i) {", `  ${send}`, "}"].join(
        "\n",
      );
  }
}

function runBlock(script: PlannedScript): string {
  const checkName = `${script.operation} ${script.target}: status ${script.expectStatus.join(" or ")}`;
  const lines: string[] = [];
  if (script.identifiers.use !== "none") {
    lines.push(
      "// Iterations with nothing to address are counted, never silently dropped — a delete-heavy load",
      "// against an empty server must not look like a clean run that simply did less work.",
      'const skipped = new Counter("kaigara_skipped_no_id");',
      "",
    );
  }
  lines.push("export function run() {", "  const request = requestFor(execution.scenario.iterationInTest);");
  if (script.identifiers.use !== "none") {
    lines.push("  if (request === null) {", "    skipped.add(1, TAGS);", "    return;", "  }");
  }
  lines.push(
    "  const response = http.request(request.method, request.url, request.body, PARAMS);",
    `  check(response, { ${JSON.stringify(checkName)}: (r) => EXPECTED_STATUS.includes(r.status) }, TAGS);`,
    "}",
    "",
    "export default run;",
  );
  return lines.join("\n");
}

/** Renders one planned script into its standalone k6 file. */
export function renderScript(script: PlannedScript, load: PlannedLoad, plan: K6Plan): string {
  const sections = [
    header(script, load),
    imports(script),
    constants(script, load, plan),
    identifierList(script),
    executorBlock(script),
    bodyBlock(script),
    generatorBlock(script),
    runBlock(script),
  ];
  return `${sections.filter((section) => section !== null).join("\n\n")}\n`;
}

/** Renders the entry point: imports every script, schedules each as one k6 scenario at its offset,
 *  and writes the end-of-run summary the orchestrator reads. */
export function renderMain(plan: K6Plan): string {
  const scripts = planScripts(plan);
  const loadByKey = new Map(plan.loads.map((load) => [load.key, load]));
  const minted = scripts.reduce((sum, script) => sum + (script.identifiers.use === "mint" ? script.identifiers.list.length : 0), 0);
  const alias = (script: PlannedScript) => script.key.split("_")[0];

  const offsets = scripts.map((script) => `+${secondsToK6Duration(script.startSeconds)}`);
  const offsetWidth = Math.max(...offsets.map((offset) => offset.length), 0);
  const fileWidth = Math.max(...scripts.map((script) => script.file.length), 0);
  const lineWidth = Math.max(...scripts.map((script) => requestLine(script).length), 0);
  const schedule = scripts.map(
    (script, index) =>
      `//   ${offsets[index].padEnd(offsetWidth)}  ${script.file.padEnd(fileWidth)}  ${requestLine(script).padEnd(lineWidth)}  ` +
      describeExecutor(script.executor, loadByKey.get(script.loadKey)?.shapeKind),
  );

  const header = [
    "// GENERATED BY KAIGARA — do not edit.",
    "//",
    `// Scenario:     ${plan.scenarioName}`,
    `// Target:       ${plan.target.baseUrl}`,
    `// Timeline:     ${plan.totalDurationSeconds}s, ${plural(plan.loads.length, "load")} → ${plural(scripts.length, "script")}, ` +
      `~${plural(plan.expectedRequests, "request")} if the target keeps up`,
    `// Identifiers:  ${plural(plan.harvested.shell, "shell")} + ${plural(plan.harvested.submodel, "submodel")} found on the ` +
      `target (${COLLECTION_PATH.shell}, ${COLLECTION_PATH.submodel}); ${minted} minted for this run's creates`,
    "//",
    "// The entry point handed to `k6 run`. Each file imported below is a complete k6 script for one",
    "// request type of one load, and runs on its own too (`k6 run <file>`). This file only puts them on",
    "// the timeline: one k6 scenario per script, started at its load's offset, all in one k6 process.",
    "// k6 runs as an external subprocess and is never linked into Kaigara (proposal sections 3.1, 12).",
    "//",
    "// Schedule:",
    ...(schedule.length > 0 ? schedule : ["//   (nothing to run)"]),
  ].join("\n");

  const importLines = scripts.map((script) => `import * as ${alias(script)} from "./${script.file}";`).join("\n");
  const scenarioLines = scripts
    .map(
      (script) =>
        `    ${script.key}: { ...${alias(script)}.EXECUTOR, startTime: ${JSON.stringify(secondsToK6Duration(script.startSeconds))}, exec: ${JSON.stringify(script.key)} },`,
    )
    .join("\n");
  const exportLines = scripts.map((script) => `export const ${script.key} = ${alias(script)}.run;`).join("\n");

  return `${header}

${importLines}

export const options = {
  scenarios: {
${scenarioLines}
  },
  // Only the statistics the orchestrator reads from the summary; per-request results are streamed.
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

// k6 calls a scenario's \`exec\` by name on this module, so each script's run() is re-exported here.
${exportLines}

// End-of-run totals, written into the directory k6 runs in for the orchestrator to reconcile against.
export function handleSummary(data) {
  return { ${JSON.stringify(SUMMARY_FILE)}: JSON.stringify(data) };
}
`;
}
