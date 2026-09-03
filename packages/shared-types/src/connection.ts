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
}
