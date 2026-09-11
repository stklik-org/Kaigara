import { useEffect, useState } from "react";
import { idtaTemplatesOrEmpty, loadIdtaTemplates } from "./templateIndex";
import type { IdtaTemplate } from "./types";

/** The IDTA template index, fetched on first use and cached for the session. Returns `[]` until it
 *  arrives, which the dropdowns render as "no options yet" rather than blocking the dialog. */
export function useIdtaTemplates(): IdtaTemplate[] {
  const [templates, setTemplates] = useState<IdtaTemplate[]>(idtaTemplatesOrEmpty);

  useEffect(() => {
    let cancelled = false;
    void loadIdtaTemplates().then((loaded) => {
      if (!cancelled) setTemplates(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return templates;
}
