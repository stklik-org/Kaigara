import type { IdtaTemplate } from "./types";

/**
 * The IDTA submodel-template index — 54 published templates and ~1 000 real idShortPaths, so the
 * dialog's "pick from template" offers `Documents[0].DocumentIds[0].DocumentDomainId` rather than
 * a free-text box.
 *
 * Loaded on demand: it is ~140 KB, needed only once a parameter dialog is open, and never on the
 * Run or Analyze screens. Regenerate it from `frontend/submodel-templates` (see that folder's
 * README) when the template library is refreshed.
 */
let cache: IdtaTemplate[] | null = null;
let inFlight: Promise<IdtaTemplate[]> | null = null;

export function idtaTemplatesOrEmpty(): IdtaTemplate[] {
  return cache ?? [];
}

export function loadIdtaTemplates(): Promise<IdtaTemplate[]> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= import("./templates.index.json").then((module) => {
    cache = module.default as IdtaTemplate[];
    return cache;
  });
  return inFlight;
}
