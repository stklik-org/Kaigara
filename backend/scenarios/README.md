# Scenario library

The folder `GET /api/scenarios` serves. Each file is one serialized scenario document — the same
shape the Load screen's drop zone accepts and the Compose screen's Code view shows, so a file here
and a file a user drags in are not two different kinds of thing. Adding a scenario is copying a
file in; there is no upload endpoint and no storage schema.

Every track carries its own `color` (a hex from the shared palette in `@kaigara/shared-types`'s
`trackPalette.ts`), so a scenario looks the same for everyone who opens it. A file that arrives
without colours gets them assigned when it is loaded — but then they only exist in that person's
session, which is why the shipped files carry theirs.

Point the library somewhere else with `KAIGARA_SCENARIOS_DIR` (absolute, or relative to the
process working directory). A file that fails to parse or validate is still *listed*, with its
issues, rather than silently missing — see `src/scenarios/library.ts`.

`backend/test/scenarioLibrary.test.ts` validates every file here, so a stray hand-edit that the
app would reject fails the build instead of the Load screen.

## What ships

| File | What it is |
|---|---|
| `shape-showcase.json` | Every load shape on one 10-minute timeline. The walkthrough scenario. |
| `persistence-latency.json` | Inject one shell, then poll for it every 1 ms. |
| `component-manufacturer.json` | StressForge profile — the baseline workload. |
| `public-website.json` | StressForge profile — read-dominant. |
| `process-integrator.json` | StressForge profile — write-heavy, extra-large submodels. |

### `persistence-latency`

Two tracks over 30 s: an `individual` load fires **one** `create shell` at t=0, and a `constant`
load reads the shell collection at **1000 req/s — one request per millisecond** for the whole run.
The question it answers is how long after the write the shell becomes visible to a reader.

Two things about it are worth knowing before reading its numbers:

- The injected shell is an `exact` payload, not a randomized one. That is the point: its
  identifier is fixed in the document, so it is known before the run rather than invented per
  request.
- `query` compiles to the **paged collection GET** (`GET /shells?limit=20`), because that is what
  the metamodel's `query` operation means today (see `src/timeline/aasOperations.ts`). So the poll
  measures when the write becomes visible to a *collection read*, not a `GET /shells/{id}`. A
  read-by-id operation would be the sharper instrument and does not exist yet.

## The StressForge profiles

`stress-forge/Cloud.StressForge/Configuration/Profiles.cs` defines three workload archetypes. The
three files above carry their **load shape** across faithfully. The request composition is
approximate on purpose — the shapes are the part that is settled.

### Shape (faithful)

`LoadService.CreateLoadPlan` gives every NBomber scenario the same shape: ramp up over a fifth of
the run, hold, ramp down over a fifth. Each profile's scenarios become one Kaigara **Track** with
exactly three Loads — `ramp` up → `constant` → `ramp` down — over StressForge's own default
invocation, `load --duration 10 --concurrent-users 100`, i.e. 600 s with 120 s ramps.

A scenario whose `ScenarioWeight` is 0 is disabled in StressForge, so it gets no track at all
(this is why `filter-shells` is absent everywhere). The remaining weights split the 100 concurrent
users the same way `CreateLoadPlan` does: floor-divide, then give the remainder to the heaviest.

### Users → request rate (the one assumption)

NBomber schedules **concurrent users**; Kaigara schedules a **request rate**. There is no exact
conversion — a VU's throughput depends on the latency being measured. These files assume a 100 ms
round trip, i.e. **10 req/s per user**, so all three profiles peak at 1000 req/s:

| Profile | shells | submodels | submodel-elements | query-language |
|---|---:|---:|---:|---:|
| component-manufacturer | 200 | 400 | 200 | 200 |
| public-website | 120 | 640 | 120 | 120 |
| process-integrator | 20 | 80 | 900 | — |

Edit the rates if a target's real latency is known; the shape and the proportions are what carry
the profile's character.

### Composition (approximate — deliberately)

Each profile's `ReadWeight`/`WriteWeight` become request weights on the track. Shell writes are
`create` (StressForge POSTs a fresh shell); submodel writes split evenly between `create` and
`update`, because `SubmodelScenario` picks POST or PUT 50/50.

Three things do not survive the translation, and should not be read as if they had:

- **Submodel-element operations.** The metamodel targets `shell` and `submodel`; there is no
  element-level target, so the `submodel-elements` track carries submodel-level requests at the
  right *rate* but the wrong *granularity*.
- **The query-language scenario.** Its searches become plain collection reads. IDTA-01002 v3 keeps
  the Query API separate, and Kaigara does not model it yet.
- **The ABAC read/write steps.** Left out on purpose rather than folded into the plain weights:
  they exercise a vendor authorization model, and Kaigara only issues standardised IDTA-01002
  calls (proposal §2.3). `component-manufacturer`'s 5:1 ABAC read:write share is simply absent.

Payload sizes stand in for StressForge's `SubmodelSize`: `normal` → 4 kB, `extra-large` → 64 kB.
Seeding counts, generator weights and submodel size are carried through verbatim as `preparation`
steps — the backend does not run those phases yet (`backend/README.md`), so they are declarative
today, but they are the profile's data shape and belong in the document.
