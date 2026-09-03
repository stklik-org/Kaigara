import type { ServerConnection } from "@kaigara/shared-types";

/** Seed targets, not fixtures: the Connect screen writes the user's own edits over these (see
 *  `lib/api/connectionsClient.ts`). Reachability starts out unknown on purpose — only an actual
 *  probe may claim a server is up. */
export const mockConnections: ServerConnection[] = [
  {
    id: "twinsphere",
    name: "twinsphere",
    environment: "conplement AG · v3 API",
    baseUrl: "https://twinsphere.example/api/v3",
    apiVersion: "IDTA-01002-3.1",
    conformanceProfile: "SSP-002 partial",
    conformanceStatus: "partial",
    reachable: "unknown",
    active: true,
    defaultTimeoutSeconds: 30,
    scrapeResourceMetrics: false,
  },
  {
    id: "basyx-local",
    name: "Eclipse BaSyx",
    environment: "local docker · v3 API",
    baseUrl: "http://localhost:8081/api/v3",
    apiVersion: "IDTA-01002-3.1",
    conformanceProfile: "SSP-001 full",
    conformanceStatus: "full",
    reachable: "unknown",
    active: false,
    defaultTimeoutSeconds: 30,
    scrapeResourceMetrics: false,
  },
];
