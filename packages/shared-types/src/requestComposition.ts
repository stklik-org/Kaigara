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
 */
export interface RequestIdPoolData {
  source: "created" | "server";
  /** Upper bound on how many identifiers the pre-load harvest pages in. Paging stops here even if
   *  the server has more — a benchmark should not spend its first minute enumerating a corpus. */
  maxIds?: number;
}

/** How one parameter of a catalogue request template was bound: which strategy was chosen, plus
 *  that strategy's own options (shaped by its JSON Schema, so this side stays untyped on purpose). */
export interface ParameterBinding {
  strategy: string;
  config?: Record<string, unknown>;
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

  constructor(data: RequestSpecInit) {
    this.id = data.id;
    this.operation = data.operation;
    this.target = data.target;
    this.weight = data.weight;
    this.generator = data.generator;
    this.templateId = data.templateId;
    this.bindings = data.bindings;
    this.idPool = data.idPool;
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
