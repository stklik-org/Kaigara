/**
 * The compile-time harvest: which identifiers exist on the target **before** the run starts,
 * paged in by the backend with plain `fetch` calls (ADR 0003). The generated k6 scripts never
 * discover server state themselves — they must not send a single request beyond the ones the
 * timeline authored — so whatever they address arrives as a literal list baked into their text.
 *
 * This module only *collects*. Deciding which script addresses which identifier — the server's,
 * ones created earlier in the run, or freshly minted ones for a create — is the pool design in
 * `compileTimeline.ts` (ADR 0005), which calls a harvester once per entity that needs one.
 */

import type { RequestTargetEntity } from "@kaigara/shared-types";

import { COLLECTION_PATH } from "../../timeline/aasOperations.ts";
import type { PlanTarget } from "./k6Plan.ts";

/** Page size for the harvest. Also what a request with no explicit `idPool` gets — one page is
 *  enough to give a read/update/delete that falls back to server data something to address. */
export const DEFAULT_HARVEST_SIZE = 100;

/** Pages up to `maxIds` identifiers of one entity off the target. Injectable, so tests and the
 *  compile step can be exercised without a server. */
export type IdentifierHarvester = (entity: RequestTargetEntity, maxIds: number) => Promise<string[]>;

/** Thrown when an explicit `idPool.source: "server"` request has nothing to draw from — the
 *  target's corpus for that entity is empty, so the plan as authored cannot be measured. */
export class EmptyServerCorpusError extends Error {
  // Explicit field rather than a constructor parameter property: Node executes this source by
  // stripping types, which cannot erase a parameter property, so `erasableSyntaxOnly` rejects one.
  readonly entity: RequestTargetEntity;

  constructor(entity: RequestTargetEntity) {
    super(
      `No ${entity} identifiers on the target: this scenario draws them from the server before the ` +
        `load starts, and the harvest came back empty.`,
    );
    this.name = "EmptyServerCorpusError";
    this.entity = entity;
  }
}

interface Page {
  result: unknown[];
  cursor: string | null;
}

/** One page of an IDTA-01002 collection GET. Deliberately tolerant of a malformed or non-JSON
 *  response — a compile-time harvest failing outright would be a worse experience than simply
 *  treating a confused server as having nothing to offer. */
async function fetchPage(target: PlanTarget, path: string, limit: number, cursor: string | null): Promise<Page> {
  let url = `${target.baseUrl}${path}?limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...target.headers },
      signal: AbortSignal.timeout(target.timeoutSeconds * 1000),
    });
  } catch {
    return { result: [], cursor: null };
  }
  if (!response.ok) return { result: [], cursor: null };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { result: [], cursor: null };
  }
  const record = body as { result?: unknown; paging_metadata?: { cursor?: unknown } } | null;
  const result = Array.isArray(record?.result) ? (record.result as unknown[]) : [];
  const cursorNext = typeof record?.paging_metadata?.cursor === "string" ? record.paging_metadata.cursor : null;
  return { result, cursor: cursorNext };
}

/** Pages one entity's collection up to `maxIds`, following `paging_metadata.cursor`. Stops on an
 *  empty page or a missing cursor — the server has no more to give. */
async function harvestEntity(target: PlanTarget, entity: RequestTargetEntity, maxIds: number): Promise<string[]> {
  const path = COLLECTION_PATH[entity];
  const ids: string[] = [];
  let cursor: string | null = null;

  while (ids.length < maxIds) {
    const limit = Math.min(DEFAULT_HARVEST_SIZE, maxIds - ids.length);
    const page = await fetchPage(target, path, limit, cursor);
    for (const item of page.result) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.push(id);
    }
    if (!page.cursor || page.result.length === 0) break;
    cursor = page.cursor;
  }
  return ids;
}

/** The harvester a real compile uses: the target's own IDTA-01002 collection endpoints. */
export function httpHarvester(target: PlanTarget): IdentifierHarvester {
  return (entity, maxIds) => harvestEntity(target, entity, maxIds);
}
