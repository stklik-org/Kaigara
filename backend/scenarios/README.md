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
| `minimal-crud.json` | One AAS + submodel through create → read → update → read → delete, 10 s apart. |
| `persistence-latency.json` | Inject one shell, then poll for it every 1 ms. |
| `purge-repository.json` | Best-effort teardown: DELETE every shell and submodel already on the target. |
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

### `minimal-crud`

One `AAS lifecycle` track, 50 s, five `individual` loads 10 s apart: `create` (a shell and a
submodel), `read`, `update`, `read`, `delete` (submodel then shell) — two requests per step, one
per entity. The smallest thing that exercises every operation in the metamodel end to end.

`read`/`update`/`delete` address an identifier, so — like every other scenario here — they draw
one from whatever is already on the target (harvested by the backend before the script is even
generated, ADR 0003), not from the entities this run just created: each VU's own confirmed-created
pool is local to that VU and does not cross between scenarios. It is a CRUD-shaped *workload*, not
a transactional check that the same entity survives the round trip.

### `purge-repository`

Two tracks, both a `constant` 200 req/s load for 120 s: one `DELETE /submodels/{id}`, one
`DELETE /shells/{id}`, each with `idPool.source: "server"` and a large `maxIds`, so the pre-load
harvest pages the *entire* shell and submodel collections before the deletes start. An empty
harvest aborts the run (there is no skip option), so if the target has shells but no submodels —
or the reverse — drop the track for the empty side before running, or run it twice.

It is **best-effort, not a guaranteed wipe**, for two reasons rooted in how the engine issues
requests today:

- **Server-harvested identifiers are not consumed.** Each iteration picks a *random* id from the
  harvested pool and never removes it (`takeId` in `src/engines/k6/compileScript.ts` only splices
  the per-VU created pool, not the seeded one). So coverage is a coupon-collector process:
  `rate × duration` has to exceed roughly `N·ln(N)` for a corpus of `N` entities before every id
  has probably been hit at least once. 200 req/s for 120 s is 24 000 attempts per repository —
  comfortable up to a few thousand entities; raise the rate or the duration for a larger target.
- **Re-draws of an already-deleted id return 404**, which is outside the delete's expected
  `[204, 200]`, so the run's *failed* count climbs steadily as coverage approaches complete. That
  is expected here and is not a server fault — read it as progress, not regression.

A truly idempotent "enumerate and delete until the collection is empty" is a different operation
than a rate-driven load, and would need an engine feature (consume server-sourced ids, or a
dedicated drain mode). Until then, re-run the scenario if a `GET /shells?limit=1` still returns
anything.

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
