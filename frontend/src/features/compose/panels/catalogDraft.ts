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

/** A fresh draft for a card the user just clicked: every parameter on its default strategy, seeded
 *  from that strategy's JSON Schema defaults. */
export function draftForTemplate(template: RequestTemplate): CatalogDraft {
  return {
    templateId: template.id,
    weight: template.defaults?.weight ?? 10,
    bindings: initBindings(template),
    editingRequestId: null,
  };
}
