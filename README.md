# 貝殻 (Kaigara)

*A generic, standards-based benchmarking tool for Asset Administration Shell (AAS) servers.*

(kaigara — "seashell": a small nod to the Administration *Shell* the tool benchmarks.)

## Status

Early scaffolding only. Scope and structure are still settling, so expect this
document — and the layout around it — to change often. Treat it as a snapshot,
not a specification. The fuller rationale lives in the project proposal and is
deliberately not repeated here, so the two don't drift out of sync.

## What this is

A tool for benchmarking AAS server implementations against realistic, reusable
"recipes": declarative descriptions of a benchmark scenario covering data
preparation, correctness preconditions, the load itself, correctness
postconditions, and cleanup.

See [`metamodel.puml`](./metamodel.puml) (source) / [`metamodel.png`](./metamodel.png)
(rendered) for the class diagram of the current Scenario / Track / Load /
LoadShape / RequestComposition domain model (the "load itself" part above),
and [`architecture.puml`](./architecture.puml) / [`architecture.png`](./architecture.png)
for the proposed system architecture (frontend, backend orchestrator, engine
adapters, target servers) — colour-coded by what's actually implemented today
versus still proposed.

## Direction: pluggable by design

The chosen architecture treats the load-generation engine as a swappable
component behind a stable interface, rather than something the rest of the
tool depends on directly. Recipes, results and the UI are engine-agnostic; a
given engine is just an adapter that knows how to turn a recipe's benchmark
phase into something runnable, and how to report results back in a common
shape. The intent is that the tool can outlive any single engine choice and
grow further adapters later without touching its core.

## Repository layout

Not fixed yet — to be filled in once the first engine adapter and recipe
format land.

## Guiding principles

- Standards-first: all interaction with a target server goes through its
  standardised API, never vendor-specific internals.
- Minimal footprint: the tool's own overhead must never compete with the load
  it is generating.
- Reusable, adaptable, extensible: recipes, target servers and engines should
  all be swappable or extendable without rewriting the core.
