import type { ParameterBinding } from "@kaigara/shared-types";
import { initBindings } from "../catalog/resolve";
import type { RequestTemplate } from "../catalog/types";

/** What the catalogue and the composition list hand to {@link ParameterDialog}: a pick being
 *  configured, and the id of the request spec it replaces when the pick is an edit rather than an
 *  addition. */
export interface CatalogDraft {
  templateId: string;
  weight: number;
  bindings: Record<string, ParameterBinding>;
  editingRequestId: string | null;
}

/** Weight for a card the user just clicked — deliberately not asked about here. Weight is a
 *  property of the composition (how this request type compares to the load's others), not of the
 *  pattern being configured, so it is set and edited only in the Composition panel's own list;
 *  every new pick starts even and gets weighed against its siblings once it is actually one of
 *  them. */
const NEW_REQUEST_WEIGHT = 1;

/** A fresh draft for a card the user just clicked: every parameter on its default strategy, seeded
 *  from that strategy's JSON Schema defaults. */
export function draftForTemplate(template: RequestTemplate): CatalogDraft {
  return {
    templateId: template.id,
    weight: NEW_REQUEST_WEIGHT,
    bindings: initBindings(template),
    editingRequestId: null,
  };
}
