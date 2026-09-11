/**
 * The (operation × target entity) → IDTA-01002 REST call table.
 *
 * This is the standards-first boundary (proposal section 2.3): everything the engine issues is
 * derived from this one table, and every entry is an endpoint from the published Asset
 * Administration Shell Repository / Submodel Repository service specifications. No vendor
 * endpoints, so the same plan runs unmodified against twinsphere and Eclipse BaSyx.
 *
 * Two details of the specification that are easy to get wrong and are handled here:
 *
 *  - Identifiers in paths are **base64url encoded**. An AAS identifier is an IRI
 *    ("https://example.com/ids/sm/1234"), which cannot go into a path segment raw. IDTA-01002
 *    encodes it; the engine does the encoding at run time, this table only marks *where* with the
 *    `{id}` placeholder.
 *  - `query` is a collection read, not a filter. IDTA-01002 v3 splits "get all with paging" from
 *    the separate Query API; the tool's "query" operation maps to the paged collection GET, which
 *    is the search-shaped operation every conformant repository implements. `read`, added
 *    alongside it, is the by-identifier GET — the two answer different questions about a server.
 */

import type { RequestOperation, RequestTargetEntity } from "@kaigara/shared-types";

/** Page size used for collection reads. Small enough that a read-heavy benchmark measures the
 *  server's request handling rather than its ability to serialise huge result sets. */
export const COLLECTION_PAGE_LIMIT = 20;

export interface AasOperationDescriptor {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Relative to the API base URL. `{id}` is replaced with a base64url-encoded identifier. */
  pathTemplate: string;
  query: Record<string, string>;
  idSource: "none" | "pool";
  consumesId: boolean;
  /** Whether this operation sends a request body at all. */
  sendsBody: boolean;
  expectStatus: number[];
}

/** Collection path per entity — the two repository interfaces Kaigara targets. Exported so the k6
 *  adapter's compile-time identifier harvest (`harvestIdentifiers.ts`) pages the same collections
 *  this table already says every other request addresses. */
export const COLLECTION_PATH: Record<RequestTargetEntity, string> = {
  shell: "/shells",
  submodel: "/submodels",
};

/**
 * Resolves one authored (operation, target) pair to its REST call.
 *
 * Status expectations follow the specification's documented responses: creation answers 201,
 * deletion 204, and updates are allowed to answer either 204 (no content) or 200 (updated entity
 * echoed back), because conformant servers differ on that point and treating one of them as an
 * error would make an otherwise-clean run look broken.
 */
export function describeOperation(operation: RequestOperation, target: RequestTargetEntity): AasOperationDescriptor {
  const collection = COLLECTION_PATH[target];

  switch (operation) {
    case "query":
      return {
        method: "GET",
        pathTemplate: collection,
        query: { limit: String(COLLECTION_PAGE_LIMIT) },
        idSource: "none",
        consumesId: false,
        sendsBody: false,
        expectStatus: [200],
      };

    case "read":
      // Read-by-identifier — the counterpart to `query`'s collection GET. Both are reads; this one
      // measures single-entity lookup rather than paging and serialising a result set, which is a
      // different cost on every server tested so far.
      return {
        method: "GET",
        pathTemplate: `${collection}/{id}`,
        query: {},
        idSource: "pool",
        consumesId: false,
        sendsBody: false,
        expectStatus: [200],
      };

    case "create":
      return {
        method: "POST",
        pathTemplate: collection,
        query: {},
        idSource: "none",
        consumesId: false,
        sendsBody: true,
        expectStatus: [201],
      };

    case "update":
      return {
        method: "PUT",
        pathTemplate: `${collection}/{id}`,
        query: {},
        idSource: "pool",
        consumesId: false,
        sendsBody: true,
        expectStatus: [200, 204],
      };

    case "delete":
      return {
        method: "DELETE",
        pathTemplate: `${collection}/{id}`,
        query: {},
        idSource: "pool",
        consumesId: true,
        sendsBody: false,
        expectStatus: [204, 200],
      };

    default: {
      // Untrusted documents are validated before they reach here, but an operation added to the
      // authoring model without a mapping must fail loudly rather than silently issue nothing.
      const unreachable: never = operation;
      throw new Error(`No IDTA-01002 mapping for operation ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The `modelType` discriminator a generated payload must carry for each entity, per IDTA-01001. */
export const MODEL_TYPE: Record<RequestTargetEntity, string> = {
  shell: "AssetAdministrationShell",
  submodel: "Submodel",
};
