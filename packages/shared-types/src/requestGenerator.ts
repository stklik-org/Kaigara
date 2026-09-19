/**
 * How a RequestSpec's payload data is produced. Mirrors the LoadShape polymorphism pattern (kind
 * field + concrete subclasses, see loadShape.ts) so the Request Composition panel can switch
 * generator-specific fields the same way LoadShapePanel switches shape-specific fields.
 */
export type RequestGeneratorKind = "randomized" | "exact" | "mutate";

export interface RandomizedGeneratorData {
  kind: "randomized";
  /** Payload size, in bytes, of each freshly-randomized request body. The size actually sent when
   *  `sizeBytesPool` is also set and has more than one entry — kept as the representative value
   *  for anything that only wants a single number (the Compose overlay's estimate, the catalogue's
   *  own preview), so it never becomes meaningless just because a pool exists. */
  sizeBytes: number;
  /** When set with more than one entry, each generated request draws its payload size uniformly
   *  at random from this pool instead of always using `sizeBytes` — e.g. one entry per submodel
   *  template family when the catalogue's "IDTA template" payload pick names more than one
   *  (`toRequestSpec.ts`'s `generatorFor`), so a run genuinely varies which one's size shows up
   *  request to request rather than picking one family once for the whole load. */
  sizeBytesPool?: number[];
}

/** A single literal payload sent on every request — hand-authored via "Specify payload in
 *  editor" rather than tuned through numeric fields, since there's no one scalar that describes
 *  a fixed value. */
export interface ExactGeneratorData {
  kind: "exact";
  value: string;
}

/** Starts from a base payload and randomly alters a share of it per request — between Randomized
 *  (no fixed structure) and Exact (no variation) for targets that need requests to look like a
 *  real record while still varying. */
export interface MutateGeneratorData {
  kind: "mutate";
  baseValue: string;
  /** Share of the base value's fields/bytes altered per request, 0-100. */
  mutationRatePercent: number;
}

export type RequestGeneratorData = RandomizedGeneratorData | ExactGeneratorData | MutateGeneratorData;

export abstract class RequestGenerator {
  abstract readonly kind: RequestGeneratorKind;
  abstract readonly label: string;
  abstract toJSON(): RequestGeneratorData;

  static fromJSON(data: RequestGeneratorData): RequestGenerator {
    switch (data.kind) {
      case "randomized":
        return new RandomizedGenerator(data);
      case "exact":
        return new ExactGenerator(data);
      case "mutate":
        return new MutateGenerator(data);
      default: {
        // Exhaustiveness guard: TS considers the switch above complete for the
        // RequestGeneratorData union, but untrusted input (e.g. a hand-edited JSON document) can
        // still carry a `kind` outside it at runtime — fail loudly here rather than silently
        // returning undefined further down the call chain.
        const unreachable: never = data;
        throw new Error(`Unknown RequestGenerator kind: ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

export class RandomizedGenerator extends RequestGenerator {
  readonly kind = "randomized" as const;
  readonly label = "Randomized";
  sizeBytes: number;
  sizeBytesPool?: number[];

  constructor(data: Omit<RandomizedGeneratorData, "kind">) {
    super();
    this.sizeBytes = data.sizeBytes;
    this.sizeBytesPool = data.sizeBytesPool;
  }

  toJSON(): RandomizedGeneratorData {
    return { kind: "randomized", sizeBytes: this.sizeBytes, ...(this.sizeBytesPool ? { sizeBytesPool: this.sizeBytesPool } : {}) };
  }

  static createDefault(): RandomizedGenerator {
    return new RandomizedGenerator({ sizeBytes: 256 });
  }
}

export class ExactGenerator extends RequestGenerator {
  readonly kind = "exact" as const;
  readonly label = "Exact";
  value: string;

  constructor(data: Omit<ExactGeneratorData, "kind">) {
    super();
    this.value = data.value;
  }

  toJSON(): ExactGeneratorData {
    return { kind: "exact", value: this.value };
  }

  static createDefault(): ExactGenerator {
    return new ExactGenerator({ value: "{}" });
  }
}

export class MutateGenerator extends RequestGenerator {
  readonly kind = "mutate" as const;
  readonly label = "Mutate";
  baseValue: string;
  mutationRatePercent: number;

  constructor(data: Omit<MutateGeneratorData, "kind">) {
    super();
    this.baseValue = data.baseValue;
    this.mutationRatePercent = data.mutationRatePercent;
  }

  toJSON(): MutateGeneratorData {
    return { kind: "mutate", baseValue: this.baseValue, mutationRatePercent: this.mutationRatePercent };
  }

  static createDefault(): MutateGenerator {
    return new MutateGenerator({ baseValue: "{}", mutationRatePercent: 20 });
  }
}
