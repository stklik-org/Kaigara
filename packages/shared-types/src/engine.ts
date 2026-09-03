/**
 * Engine adapter identifiers. Kaigara targets a pluggable multi-engine architecture (proposal §5.3,
 * "Option C") but only the k6 adapter is being implemented initially — everything else is a
 * placeholder for a future adapter, not a promise of one.
 */
export type EngineId = "k6";

export interface EngineDescriptor {
  id: EngineId;
  name: string;
  status: "available" | "planned";
}

export const ENGINES: EngineDescriptor[] = [{ id: "k6", name: "Grafana k6", status: "available" }];
