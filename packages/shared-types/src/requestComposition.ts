import { RandomizedGenerator, RequestGenerator, type RequestGeneratorData } from "./requestGenerator.ts";

/**
 * What a Load actually sends. Deliberately minimal for now — target-entity specifics (submodel
 * subtype, semanticId source, ...) are out of scope until a later pass; this models *which* AAS
 * operation, against *which* entity type, its relative share of the Load, and (via `generator`)
 * how its payload data is produced.
 */
export type RequestOperation = "create" | "read" | "update" | "delete" | "query";
export type RequestTargetEntity = "shell" | "submodel";

/**
 * Where a request gets the identifier it addresses.
 *
 *  - `created` (the default when this is absent) — the identifiers this run created itself, with
 *    the engine falling back to whatever it found on the server. Cheap, and correct for a run that
 *    populates its own data.
 *  - `server`  — every identifier is paged off the target **before the load starts** and shared by
 *    all virtual users, so the run measures access to data it did not create. This is the honest
 *    setting for benchmarking an existing corpus, and the only one whose numbers mean anything
 *    when the scenario contains no creates at all.
 *
 * Executable, unlike `bindings`: the engine reads it. It is on the spec rather than the run
 * because different requests in one load may legitimately want different sources.
 *
 * Meaningful for `read`/`update`/`delete`, which address an existing identifier — and, as the one
 * exception, also for `create`: an `idPool` on a `create` means "POST to an identifier that
 * already exists" rather than "mint a new one" (see `RequestMintIdData`, the create-only
 * counterpart for minting), a deliberate duplicate rather than a mistake. Its mere presence is
 * what the engine reads as that choice; `source`/`maxIds`/`onEmpty` mean exactly the same thing
 * they do everywhere else.
 */
export interface RequestIdPoolData {
  source: "created" | "server";
  /** Upper bound on how many identifiers the pre-load harvest pages in. Paging stops here even if
   *  the server has more — a benchmark should not spend its first minute enumerating a corpus. */
  maxIds?: number;
  /** What to do when `source: "server"` harvests nothing for this request's entity. `"warn"` (the
   *  default when absent) skips every request this one would have sent and says so in the run's
   *  warnings, the same as any other empty pool. `"fail"` refuses to compile the timeline at all —
   *  the stricter, opt-in choice for a request whose whole point is measuring a corpus that must
   *  already exist. Only meaningful for `source: "server"`; the validator warns if set otherwise. */
  onEmpty?: "warn" | "fail";
}

/** How one parameter of a catalogue request template was bound: which strategy was chosen, plus
 *  that strategy's own options (shaped by its JSON Schema, so this side stays untyped on purpose). */
export interface ParameterBinding {
  strategy: string;
  config?: Record<string, unknown>;
}

/**
 * For a `create` whose body should embed real references to entities created earlier in the
 * timeline — an Asset Administration Shell's own `submodels` list, in the one case the engine
 * currently renders (`operation: "create"`, `target: "shell"`, `target: "submodel"` here, and a
 * `randomized` generator; anything else is accepted but never consulted, and the validator warns).
 * The referenced identifiers come only from this run's own earlier creates, never the server's —
 * "previously created", not "already existing".
 */
export interface RequestReferenceData {
  /** Which entity's already-minted identifiers to embed. */
  target: RequestTargetEntity;
  /** How many to embed per created instance — a distinct slice of `target`'s pool per iteration,
   *  so e.g. 30 submodels split 3-per-shell across 10 shells never repeats one. */
  count: number;
}

/**
 * For a `create`: the identifier format each new instance's own id should follow, instead of the
 * engine's default opaque one. `format` must contain the placeholder `<Num>` exactly once,
 * replaced by a counter — one per entity type, shared by every `create` in the scenario that mints
 * this way, so `urn:kaigara:aas:<Num>` numbers every shell the scenario creates in one unbroken
 * sequence regardless of which load or track creates it.
 *
 * The counterpart, "reuse an identifier that already exists instead of minting one", is not a
 * separate field: it is `idPool` (requestComposition.ts), authored on the `create` itself — its
 * mere presence is what the engine reads as "duplicate on purpose" (see `RequestIdPoolData`'s own
 * doc comment for why a create doing this is never silently wrong).
 */
export interface RequestMintIdData {
  /** A literal identifier template containing exactly one `<Num>` placeholder, e.g.
   *  `"urn:kaigara:aas:<Num>"`. */
  format: string;
}

export interface RequestSpecData {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  /** Relative share versus this Load's other RequestSpecs — doesn't need to sum to 100. */
  weight: number;
  generator: RequestGeneratorData;
  /**
   * Which catalogue request template this spec was authored from
   * (`frontend/src/features/compose/catalog/request-templates/*.json`), e.g. "read-submodel".
   *
   * Additive and optional: `operation`/`target`/`generator` above remain the executable truth, so
   * a document written before the catalogue existed still loads, and the engine's IDTA-01002
   * mapping table stays the single source of endpoints. This records the *intent* — which pattern
   * the user picked and how they parameterised it — so the editor can reopen it and a later
   * compiler can act on the detail the four-way operation×target mapping cannot express.
   */
  templateId?: string;
  /** Parameter id → binding, for the template named by {@link templateId}. */
  bindings?: Record<string, ParameterBinding>;
  /** Where the addressed identifier comes from. Absent means "created", the historical behaviour. */
  idPool?: RequestIdPoolData;
  /** For a `create`: real references to embed in the body, drawn from another entity this run
   *  created earlier — see {@link RequestReferenceData}. Absent means the body carries none. */
  references?: RequestReferenceData;
  /** For a `create`: the identifier format each new instance should follow — see
   *  {@link RequestMintIdData}. Absent means the engine's own opaque default. */
  mintId?: RequestMintIdData;
}

export interface RequestSpecInit {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  weight: number;
  generator: RequestGenerator;
  templateId?: string;
  bindings?: Record<string, ParameterBinding>;
  idPool?: RequestIdPoolData;
  references?: RequestReferenceData;
  mintId?: RequestMintIdData;
}

export class RequestSpec {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  weight: number;
  generator: RequestGenerator;
  templateId?: string;
  bindings?: Record<string, ParameterBinding>;
  idPool?: RequestIdPoolData;
  references?: RequestReferenceData;
  mintId?: RequestMintIdData;

  constructor(data: RequestSpecInit) {
    this.id = data.id;
    this.operation = data.operation;
    this.target = data.target;
    this.weight = data.weight;
    this.generator = data.generator;
    this.templateId = data.templateId;
    this.bindings = data.bindings;
    this.idPool = data.idPool;
    this.references = data.references;
    this.mintId = data.mintId;
  }

  toJSON(): RequestSpecData {
    const data: RequestSpecData = {
      id: this.id,
      operation: this.operation,
      target: this.target,
      weight: this.weight,
      generator: this.generator.toJSON(),
    };
    // Omitted rather than written as undefined: a spec authored before the catalogue existed must
    // round-trip to byte-identical JSON, which is what the Code view shows and the run posts.
    if (this.templateId !== undefined) data.templateId = this.templateId;
    if (this.bindings !== undefined) data.bindings = this.bindings;
    if (this.idPool !== undefined) data.idPool = this.idPool;
    if (this.references !== undefined) data.references = this.references;
    if (this.mintId !== undefined) data.mintId = this.mintId;
    return data;
  }

  static fromJSON(data: RequestSpecData): RequestSpec {
    return new RequestSpec({
      id: data.id,
      operation: data.operation,
      target: data.target,
      weight: data.weight,
      generator: RequestGenerator.fromJSON(data.generator),
      templateId: data.templateId,
      bindings: data.bindings,
      idPool: data.idPool,
      references: data.references,
      mintId: data.mintId,
    });
  }

  static createDefault(): RequestSpec {
    return new RequestSpec({
      id: `req-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      operation: "query",
      target: "submodel",
      weight: 1,
      generator: RandomizedGenerator.createDefault(),
    });
  }
}

export interface RequestCompositionData {
  requests: RequestSpecData[];
}

export class RequestComposition {
  requests: RequestSpec[];

  constructor(requests: RequestSpec[]) {
    this.requests = requests;
  }

  totalWeight(): number {
    return this.requests.reduce((sum, request) => sum + request.weight, 0);
  }

  toJSON(): RequestCompositionData {
    return { requests: this.requests.map((request) => request.toJSON()) };
  }

  static fromJSON(data: RequestCompositionData): RequestComposition {
    return new RequestComposition(data.requests.map(RequestSpec.fromJSON));
  }

  static empty(): RequestComposition {
    return new RequestComposition([]);
  }
}
