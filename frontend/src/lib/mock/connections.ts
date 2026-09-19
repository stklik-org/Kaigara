import type { ServerConnection } from "@kaigara/shared-types";

/** Seed targets, not fixtures: the Connect screen writes the user's own edits over these (see
 *  `lib/api/connectionsClient.ts`). Reachability starts out unknown on purpose — only an actual
 *  probe may claim a server is up. */
export const mockConnections: ServerConnection[] = [
  {
    id: "twinsphere-jku",
    name: "Twinsphere JKU",
    environment: "conplement AG · JKU cloud tenant · v3 API",
    baseUrl: "https://jku.cloud.twinsphere.io/api/v3",
    apiVersion: "IDTA-01002-3.1",
    conformanceProfile: "SSP-002 partial",
    conformanceStatus: "partial",
    reachable: "unknown",
    active: true,
    defaultTimeoutSeconds: 30,
    scrapeResourceMetrics: false,
    // Token URL, client ID and scope are this tenant's own — not secrets — so they ship filled
    // in; `clientSecret` is intentionally blank; open this connection's Edit form and fill it in
    // (or check `applyTwinsphereDevDefaults`/`.env.local` for a way to do that without retyping it
    // every time `localStorage` is cleared).
    oauth2: {
      tokenUrl: "https://twinsphere.ciamlogin.com/459c81d1-955b-4f6e-b029-5f993e192336/oauth2/v2.0/token",
      clientId: "ea23d58a-e180-45ab-9ad6-141c7edbfb01",
      clientSecret: "",
      scope: "api://twinsphere-server-prod-jku-api/.default",
    },
  },
  {
    id: "twinsphere-demo",
    name: "Twinsphere Demo",
    // `.example` on purpose — a placeholder domain, not a real tenant this repo knows about. Fill
    // in a real base URL (and, if it needs one, an OAuth2 block like `twinsphere-jku`'s above)
    // before using this entry for anything.
    environment: "placeholder · fill in a real tenant before use",
    baseUrl: "https://twinsphere-demo.example/api/v3",
    apiVersion: "IDTA-01002-3.1",
    conformanceProfile: "not declared",
    conformanceStatus: "unknown",
    reachable: "unknown",
    active: false,
    defaultTimeoutSeconds: 30,
    scrapeResourceMetrics: false,
  },
  {
    id: "fake-aas-local",
    name: "Fake AAS (local)",
    // Kaigara's own in-memory stub, not a real AAS server implementation — see
    // `npm run stub-aas -w backend`. Useful for trying Compose/Run without any real target.
    environment: "Kaigara's own stub · npm run stub-aas -w backend",
    baseUrl: "http://127.0.0.1:8081/api/v3",
    apiVersion: "IDTA-01002-3.1",
    conformanceProfile: "not declared",
    conformanceStatus: "unknown",
    reachable: "unknown",
    active: false,
    defaultTimeoutSeconds: 30,
    scrapeResourceMetrics: false,
  },
  {
    id: "basyx-local",
    name: "Eclipse BaSyx",
    // Same default port the stub above uses — run one or the other locally, not both at once.
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
