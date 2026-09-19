/** Credentials for an OAuth2 client-credentials exchange (e.g. twinsphere's service-account
 *  flow against its Entra ID CIAM tenant): the backend exchanges these for a bearer access token
 *  itself, just before a probe or a run, and merges `Authorization: Bearer <token>` into the
 *  connection's `headers` — the secret never crosses into a k6 script or the browser's fetch. Kept
 *  distinct from `headers` because it needs *behaviour* (a token exchange with caching/refresh),
 *  not just a value to send verbatim. */
export interface OAuth2ClientCredentials {
  /** The token endpoint, e.g. "https://<tenant>.ciamlogin.com/<tenant-id>/oauth2/v2.0/token". */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** The resource scope to request, e.g. "api://<api-id>/.default". */
  scope: string;
}

/** A configured target AAS server (e.g. twinsphere, Eclipse BaSyx). See proposal §3.3. */
export interface ServerConnection {
  id: string;
  name: string;
  /** Free-text label, e.g. "conplement AG" or "local docker". */
  environment: string;
  baseUrl: string;
  /** e.g. "IDTA-01002-3.1" */
  apiVersion: string;
  /** Declared AAS conformance profile(s), e.g. "SSP-002". Recorded so cross-server
   *  comparisons stay honest about differing implemented surfaces (proposal §3.3/§14).
   *  This is what the *user* declares; what the server actually advertises comes back in
   *  `lastTest.profiles`, and the two are shown side by side rather than merged. */
  conformanceProfile: string;
  conformanceStatus: "full" | "partial" | "unknown";
  reachable: boolean | "unknown";
  active: boolean;
  defaultTimeoutSeconds: number;
  scrapeResourceMetrics: boolean;
  /** Extra headers sent with every request to this target — an `Authorization` bearer token, an
   *  API key header, whatever this particular server wants. Applied to both the reachability
   *  probe and every request an actual run issues (`PlanTarget.headers`), so "Test" and "Run" see
   *  the same server. There is no token-exchange support yet: a value here is sent verbatim on
   *  every request, so it has to already be whatever the server accepts (a static API key, or a
   *  bearer token you refresh by hand) rather than a client secret needing an OAuth2 exchange.
   *  Stored in `localStorage` like the rest of the connection (`backend/README.md`) — this is
   *  dev-grade credential storage, not a secrets vault. */
  headers?: Record<string, string>;
  /** When set, the backend exchanges these for a fresh bearer token before every probe and every
   *  run and merges it into `headers` as `Authorization` — see `OAuth2ClientCredentials`. Takes
   *  precedence over a manually authored `Authorization` header of the same connection. */
  oauth2?: OAuth2ClientCredentials;
  /** Result of the most recent reachability probe, if one has been run this session. */
  lastTest?: ConnectionTestResult;
}

/** Fields a user supplies when adding or editing a connection; everything else is derived. */
export interface ConnectionInput {
  name: string;
  baseUrl: string;
  environment?: string;
  apiVersion?: string;
  conformanceProfile?: string;
  defaultTimeoutSeconds?: number;
  scrapeResourceMetrics?: boolean;
  headers?: Record<string, string>;
  /** `undefined` leaves the connection's existing `oauth2` untouched; `null` clears it. See
   *  `ServerConnection.oauth2`. */
  oauth2?: OAuth2ClientCredentials | null;
}

export type ConnectionErrorKind =
  | "timeout"
  | "dns"
  | "refused"
  | "tls"
  | "http"
  | "network"
  | "invalid-url"
  /** The probe service itself (the Kaigara backend) could not be reached — a local problem,
   *  not a statement about the target server. */
  | "probe-unavailable"
  /** The `oauth2` token exchange itself failed (bad client secret, wrong scope, tenant
   *  unreachable) — distinct from the target server rejecting the resulting token, which still
   *  reports as an ordinary HTTP 401/403. */
  | "auth"
  | "unknown";

/**
 * Outcome of probing a target server's IDTA-01002 Service Description endpoint
 * (`GET {baseUrl}/description`), falling back to `GET {baseUrl}/shells` for servers that do not
 * implement it. Deliberately engine-agnostic and vendor-neutral: everything here comes from the
 * standardised REST API, never from server internals.
 */
export interface ConnectionTestResult {
  reachable: boolean;
  /** The absolute URL that was actually requested, e.g. "http://localhost:8081/api/v3/description". */
  probedUrl: string;
  /** Which endpoint answered — `description` normally, `shells` when the former is missing. */
  probedEndpoint: "description" | "shells";
  /** HTTP status of the probe response, when one arrived at all. */
  httpStatus?: number;
  /** Wall-clock time of the probe request, in milliseconds. */
  latencyMs?: number;
  /** Profile IRIs the server advertises (ServiceDescription.profiles), e.g.
   *  ".../AssetAdministrationShellRepositoryServiceSpecification/SSP-002". */
  profiles?: string[];
  /** Short, human-readable summary for the UI. */
  detail: string;
  error?: { kind: ConnectionErrorKind; message: string };
  /** ISO-8601 timestamp of when the probe ran. */
  checkedAt: string;
}

/** Request body of the backend's `POST /api/connections/test`. */
export interface ConnectionTestRequest {
  baseUrl: string;
  timeoutSeconds?: number;
  /** Same headers a run against this connection would send — see `ServerConnection.headers`. */
  headers?: Record<string, string>;
  /** Same OAuth2 credentials a run against this connection would use — see
   *  `ServerConnection.oauth2`. */
  oauth2?: OAuth2ClientCredentials;
}
