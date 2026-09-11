import type { RequestOperation } from "@kaigara/shared-types";

/**
 * One colour per CRUD-ish operation, reused by the catalogue cards' edge stripe and the
 * composition mix bar so the two read as the same taxonomy.
 *
 * Deliberately built from the existing semantic tokens rather than new ones: reads are the "safe"
 * green, writes the warning amber, deletes the failure red, and the two blues separate a create
 * from a search. Every one of them re-themes in dark mode for free.
 */
export const OPERATION_COLOR: Record<RequestOperation, string> = {
  create: "var(--color-accent)",
  read: "var(--color-status-pass)",
  update: "var(--color-status-warn)",
  delete: "var(--color-status-fail)",
  query: "var(--color-track-magenta)",
};

/** The verb a spec authored before the catalogue existed will be issued with — the same mapping
 *  the engine's IDTA-01002 table uses, so a legacy row shows the truth. */
export const OPERATION_METHOD: Record<RequestOperation, string> = {
  create: "POST",
  read: "GET",
  update: "PUT",
  delete: "DELETE",
  query: "GET",
};
