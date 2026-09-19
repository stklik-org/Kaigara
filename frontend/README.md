# Kaigara frontend

The React 19 / TypeScript / Vite app: the Connect → Load → Compose → Run → Analyze screens,
implemented from the lofi wireframes under
`../docs/Benchmark UI prototype/design_handoff_aas_benchmarking_ui/`. Those wireframes encode
intentional layout decisions, so check them before changing UI structure. Styling is Tailwind v4,
state is Zustand, routing is React Router. The Compose screen is built on
`@xzdarcy/react-timeline-editor` (the track canvas) and Monaco (the Code view).

## Running it

From the repository root, the whole stack in one terminal:

```bash
npm run dev                  # orchestrator :5174 + stub AAS :8081 + this app on http://localhost:5173
npm run dev -- --no-stub     # the same, for aiming at a real AAS server
npm run stop                 # free the three ports if an earlier copy is still holding them
```

That also sets `KAIGARA_BACKEND_URL` for you. For Connect, Load and Compose, this workspace alone
is enough:

```bash
npm run dev -w frontend      # http://localhost:5173
```

This works because the Vite dev server mounts the backend's connection-probe and scenario-library
modules in-process (see `vite.config.ts`). Both need nothing but a network socket and a
filesystem. **Running a benchmark needs the real orchestrator**, which the dev server does not
stand in for. Set `KAIGARA_BACKEND_URL` and Vite drops those two middlewares and proxies all of
`/api` to the orchestrator instead:

```bash
npm run dev -w backend                                              # terminal 1
KAIGARA_BACKEND_URL=http://127.0.0.1:5174 npm run dev -w frontend   # terminal 2
```

Without it, the Run screen posts into the Vite dev server and gets a 404.

A production build has no middleware at all. The orchestrator serves it itself
(`KAIGARA_UI_DIR=frontend/dist`, which is what the root `Dockerfile` does), and the app calls the
API with relative `/api/...` paths, so there is no base URL to configure.

Inside the Dev Container, `npm run dev` passes `--host` to Vite, since Vite ignores the
container's `HOST=0.0.0.0`. If you start this workspace on its own there, use
`npm run dev -w frontend -- --host` when it has to be reachable through a published port rather
than VS Code's forwarding.

### Environment

| Variable | Read by | Effect |
|---|---|---|
| `KAIGARA_BACKEND_URL` | `vite.config.ts`, dev server only | Proxy `/api` to this orchestrator instead of mounting the in-process probe and library. |
| `VITE_TWINSPHERE_BASE_URL`, `VITE_TWINSPHERE_AUTH_HEADER`, `VITE_TWINSPHERE_AUTH_VALUE` | `lib/api/twinsphereDevDefaults.ts` | Dev convenience: they fill in the URL and credentials of the shipped `twinsphere` connection, so they survive a `localStorage` clear. They only fill gaps and never overwrite what the Connect form has saved. |

Put the `VITE_TWINSPHERE_*` values in the gitignored `.env.local`, never in `.env` or
`.env.example`. `vite build` inlines `VITE_*` values into the bundle, so a `dist/` built on a
machine that has them set carries the token. The Docker build is protected (`.dockerignore`
excludes `.env.*`), but any other build is not.

## Checks

```bash
npm run build -w frontend    # tsc -b && vite build
npm run lint -w frontend     # oxlint
```

There are no frontend tests yet. What the metamodel guarantees is tested one level down, in
`@kaigara/shared-types` (`npm test` and `npm run schema:check` there). The backend modules the dev
server mounts are tested in `@kaigara/backend`.

## The screens today

| Screen | State |
|---|---|
| **Connect** | Real. The user's target servers: add and edit them (base URL, timeout, and any headers the server wants verbatim, such as a bearer token or an API key), **Test** one through the backend's standards-only probe, and **Activate** the one runs will target. |
| **Load** | Real. Three ways into Compose: **generate** a scenario from a plain-language description (see [AI assist](#ai-assist)), **drop or pick** a single JSON file, or open a card from the orchestrator's **scenario library**. A library file that fails to parse still shows up, as an unopenable card listing its issues. |
| **Compose** | Real. The timeline editor, with a *Visual* view (the track canvas, the expected-requests overlay, and the info row: Load shape · Request composition · Request catalogue) and a *Code* view (Monaco over the same JSON). Its header, portalled into the app bar through `app/HeaderSlots.tsx`, has rename, **Edit with AI**, **Upload** and **Download** of the timeline as JSON (a real Save-As dialog in Chromium, a plain download elsewhere), and **Run**, which only *opens* the Run screen. **Save** is a placeholder ("Not wired up yet"): the library is read-only and there is no endpoint to write to. |
| **Run** | Real. Its own **Run** button posts the composed timeline from `scenarioStore` against the active connection. `?runId=` follows an existing run instead, after a reload or from a deep link. Shows the track canvas with live req/s, total, failed and p95 over SSE, plus **Stop**. Dropped iterations get a prominent warning, because they mean the load generator, not the server, was the bottleneck. A **Concrete plan** toggle shows the compiled per-load schedule from `POST /api/runs/concrete-plan` without sending anything. |
| **Analyze** | Mock data, from `lib/mock/analysis.ts`. |

Opening `/` resumes on Compose when a draft was restored (see [below](#the-document-behind-compose)),
and lands on Connect otherwise.

## What is real, and what is not

The seam is `lib/api/`: `client.ts` declares the `ApiClient` interface, `ApiProvider` supplies an
implementation through context, and `defaultClient.ts` composes the one the app runs on. Every
screen reads it via `useApi()` and never touches a data module directly. So moving a slice off mocks
means implementing it here, with no changes to feature code.

| Slice | State |
|---|---|
| `connectionsClient` | **Real.** `test()` probes the target server through the backend. It sends whatever `headers` the connection carries (Authorization, an API key, …), the same ones a run against that connection uses. The connection list itself stays in `localStorage` until the backend owns connections. |
| `scenariosClient` | **Real.** Reads the orchestrator's scenario-library folder. Files that fail to parse come back *listed* with their issues, rather than silently vanishing. |
| `runsClient` | **Real.** `start()` posts `LoadTimeline.toJSON()` to `POST /api/runs`, byte-identical to what the Code view shows. Live state arrives over SSE, and `concretePlan()` backs the Run screen's plan view. |
| `mockClient` | Everything else, from `lib/mock/`. Only **analysis** is still mock data. Its `scenarios` and `runs` methods reject with "requires the Kaigara backend" rather than faking a run: inventing latency numbers for someone who came to measure real ones is worse than an error. |
| `httpError.ts` | One `ApiRequestError` base and one response reader, so every slice surfaces the backend's `{ error, issues }` the same way. |

## AI assist

`lib/assist/` is an optional LLM step behind two buttons. On Load, **Generate from description**
turns a description into a new scenario. On Compose, **Edit with AI** turns an instruction into
the whole edited timeline. Supported providers are Hugging Face (the Inference Providers router),
OpenAI and Anthropic, plus any OpenAI-compatible endpoint through a base-URL override. The gear
button opens `LlmSettingsDialog`, which checks the key with one authenticated call to the
provider and then offers only the models that key can reach.

- **It runs in the browser only.** The page calls the provider directly. The config, API key
  included and unencrypted, lives in `localStorage`. None of it passes through the orchestrator,
  which holds no AI credentials. A backend passthrough could replace `createChatClient`
  (`chatClient.ts`) later without touching either flow.
- **Its output is treated as untrusted text.** The prompt (`scenarioPrompt.ts`) inlines the
  load-timeline JSON Schema verbatim, with a cheat-sheet of the semantics the schema cannot carry
  and worked examples. The reply goes through the same `loadTimelineValidation` gate as a
  Code-view edit, with one repair round-trip that feeds the issues back. A generated scenario
  lands in Compose for review; nothing in this folder starts a benchmark.
- The ready-made descriptions in `features/load/exampleDescriptions.ts` double as few-shot pairs
  in that prompt, so keep their wording in step with the gold documents.

## Browser storage

Everything the app remembers lives in `localStorage`, through `lib/storage.ts`, which cannot
throw:

| Key | Holds |
|---|---|
| `kaigara.connections.v1` | The connection list, including any headers (tokens) it carries. |
| `kaigara.compose.timelineDraft.v1` | The autosaved Compose draft. |
| `kaigara.llm.v1` | The AI-assist provider, model, base URL and API key. |
| `kaigara-theme` | Light or dark. |
| `kaigara.compose.sidebarWidth`, `…paneSizes`, `…infoColumns` | The Compose layout. |

The first and third entries hold credentials unencrypted. That is the trust model of any
browser-side token: acceptable on your own machine, but worth knowing before using a shared one.

## Layout

- `app/` — `AppShell` (the persistent Connect→Load→Compose→Run→Analyze pill nav, click-to-jump
  rather than a wizard), the theme provider, and `HeaderSlots` (the two portal slots in the app
  bar that Compose and Run render their title and controls into, so there is one header rather
  than two). Routes are declared in `App.tsx`.
- `features/{connect,load,compose,run,analyze}/` — one folder per lifecycle stage.
  - `compose/` has the most going on: `timeline/` (the track canvas, its adapters and model
    factories, track colours, zoom), `panels/` (the info row: Load shape · Request composition ·
    Request catalogue, in draggable columns, plus the parameter dialog), `catalog/` (the payload
    editor's data and its pure logic, see below), `overlay/` (the expected-requests preview),
    `editor/` (the Monaco JSON view and its serialization), `store/` (`scenarioStore`, the single
    source of truth both views read and write, and the draft autosave) and `AiEditDialog`.
  - `load/` holds the drop zone, the library cards and the generate-from-description box with its
    LLM settings dialog. `connect/` holds the connection form and the probe-result view. `run/`
    holds the live timeline, which reuses `compose/timeline`'s renderers, and `ConcretePlanView`.
- `components/ui/` — small presentational primitives: `Badge`, `Button`, `Panel`,
  `SegmentedControl`, `IssueList`, `ResizableRows`, `ResizableColumns`.
- `components/charts/` — dependency-free hand-rolled SVG charts, an explicit placeholder for uPlot.
  Once real streaming metrics exist, swap them behind the same prop shape rather than growing them
  into a charting library.
- `lib/api/` — the data seam described above.
- `lib/assist/` — the LLM step described above.
- `lib/` — the two cross-cutting helpers: `storage` (all `localStorage` goes through it) and
  `useAsyncData` (every fetch-on-mount, which owns the cancellation flag each screen used to
  hand-roll).
- `types/` — ambient declarations, currently just the slice of the File System Access API the
  Save-As download uses.

Imports that cross a top-level boundary use the `@/` alias; imports within a feature stay
relative. There should be no `../../` anywhere.

### The request catalogue

`compose/catalog/` is the payload editor. What a Load sends is picked from a catalogue of request
patterns, and **the catalogue is data**: `request-templates/*.json` is one file per card,
`parameter-types/*.json` is one file per way of filling a parameter, and each strategy carries its
own JSON Schema, which the parameter dialog renders. So adding an endpoint or a generation strategy
is a file drop. `import.meta.glob` picks it up with no build step, and `catalogIssues()` reports a
card that references a strategy which does not exist.

The rest of the folder is deliberately DOM-free. `resolve.ts` turns a template plus its bindings
into a resolved URL, a body preview and the expected status codes. A strategy may override those,
which is how "non-existing" becomes a 404 test. `toRequestSpec.ts` is the single seam onto the
metamodel: a pick becomes an ordinary `RequestSpec`, where `operation`/`target`/`weight`/`generator`
stay the executable truth and `templateId`/`bindings` ride along so the dialog can reopen it. The
catalogue describes endpoints the engine cannot issue yet (`$value`, `/attachment`, `$query`,
sequences), so `engineGaps()` spells out what is approximated. That shows in the dialog and as an
"approximated" badge in the composition list, and it is derived from the backend's own mapping
table rather than restated here.

The element dropdowns offer real idShortPaths from `templates.index.json`, an index generated from
the IDTA submodel templates. `templateIndex.ts` imports it lazily on first use (through the
`useIdtaTemplates` hook), so its ~140 KB stays out of the main bundle.

Beside `src/` (and therefore not bundled) sits `submodel-templates/`: the official IDTA material,
downloaded rather than committed. It holds every published submodel template (PDF + AASX + JSON),
the AAS metamodel schemas, and the IDTA-0100x specification PDFs. Only its `README.md`,
`refresh.sh`, `index.py` and `inventory.json` are in git, so a fresh clone gets the data with
`./submodel-templates/refresh.sh` (~30 s, 177 MB). `inventory.json` is the index worth reading
first: every template's IDTA number, version, `idShort`, `semanticId` and element count.

## The document behind Compose

The Visual and Code views are two renderings of **one** `LoadTimeline`, not an editor plus an
export. Serialization is just `JSON.stringify(timeline)`, and those bytes are what gets posted to
`POST /api/runs` and what Download writes. Upload and Edit with AI both replace the document
through the same validation as a Code-view edit. Keeping that true has a few sharp edges: never
object-spread a metamodel instance, parse untrusted text through the shared validator, and make
invalid edits report instead of silently stopping the sync. The root `CLAUDE.md` spells these out
with the reasoning, so read it before touching `compose/`.

That timeline **autosaves to `localStorage`** as it is edited (`compose/store/timelinePersistence.ts`).
`scenarioStore` boots its initial state from the stored draft and, once a scenario is open, writes
it back debounced on every change. `App.tsx` reads the restored name so that opening the app at
`/` lands on Compose, resuming the last edit, rather than on Connect. The draft is browser-local
only. It is not the scenario library, and loading a library scenario just overwrites it. A stored
draft that no longer parses against the current metamodel is dropped on read, which is also why
the key carries a `.v1` suffix.

Domain types and the load-timeline metamodel live in `@kaigara/shared-types`, shared with the
backend, and are drawn in `../metamodel.png`.
