import { RandomizedGenerator, RequestGenerator, type RequestGeneratorData } from "./requestGenerator.ts";

/**
 * What a Load actually sends. Deliberately minimal for now — target-entity specifics (submodel
 * subtype, semanticId source, ...) are out of scope until a later pass; this models *which* AAS
 * operation, against *which* entity type, its relative share of the Load, and (via `generator`)
 * how its payload data is produced.
 */
export type RequestOperation = "create" | "update" | "delete" | "query";
export type RequestTargetEntity = "shell" | "submodel";

export interface RequestSpecData {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  /** Relative share versus this Load's other RequestSpecs — doesn't need to sum to 100. */
  weight: number;
  generator: RequestGeneratorData;
}

export interface RequestSpecInit {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  weight: number;
  generator: RequestGenerator;
}

export class RequestSpec {
  id: string;
  operation: RequestOperation;
  target: RequestTargetEntity;
  weight: number;
  generator: RequestGenerator;

  constructor(data: RequestSpecInit) {
    this.id = data.id;
    this.operation = data.operation;
    this.target = data.target;
    this.weight = data.weight;
    this.generator = data.generator;
  }

  toJSON(): RequestSpecData {
    return { id: this.id, operation: this.operation, target: this.target, weight: this.weight, generator: this.generator.toJSON() };
  }

  static fromJSON(data: RequestSpecData): RequestSpec {
    return new RequestSpec({
      id: data.id,
      operation: data.operation,
      target: data.target,
      weight: data.weight,
      generator: RequestGenerator.fromJSON(data.generator),
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
