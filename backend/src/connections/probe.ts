import type { ConnectionErrorKind, ConnectionTestRequest, ConnectionTestResult } from "@kaigara/shared-types";

/**
 * Reachability / conformance probe for a target AAS server.
 *
 * Standards-first (proposal §3.1): the only thing we ask a server is its IDTA-01002 Service
 * Description (`GET {baseUrl}/description`), which every conformant v3 server exposes and which
 * advertises the profiles it implements. Servers that predate or skip that endpoint are given a
 * second chance via `GET {baseUrl}/shells`, so "no /description" is reported as a caveat rather
 * than as an outage. No vendor-specific health endpoints, ever.
 *
 * This runs in the backend rather than the browser on purpose: a browser probe would be blocked
 * by CORS for most targets and could not tell "server is down" apart from "server refused the
 * cross-origin read".
 */

const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 120;

/** Trailing slashes and a stray `/description` are the two things users paste by accident. */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("No base URL given.");

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`"${trimmed}" has no http(s):// scheme (expected e.g. http://localhost:8081/api/v3).`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${trimmed}" is not a valid absolute URL (expected e.g. http://localhost:8081/api/v3).`);
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/description$/, "");
  return `${url.origin}${path}`;
}

function clampTimeoutSeconds(seconds: number | undefined): number {
  if (!Number.isFinite(seconds) || (seconds as number) <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(seconds as number, MAX_TIMEOUT_SECONDS);
}

/** Maps a `fetch` rejection onto something a user can act on. */
function classifyTransportError(err: unknown): { kind: ConnectionErrorKind; message: string } {
  const error = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return { kind: "timeout", message: "The server did not answer before the timeout elapsed." };
  }

  const code = error?.cause?.code ?? "";
  const causeMessage = error?.cause?.message ?? error?.message ?? "Request failed.";
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { kind: "dns", message: "Host name could not be resolved." };
    case "ECONNREFUSED":
      return { kind: "refused", message: "Connection refused — nothing is listening on that host/port." };
    case "ECONNRESET":
    case "EPIPE":
      return { kind: "network", message: "The connection was reset before a response arrived." };
    case "ETIMEDOUT":
      return { kind: "timeout", message: "The TCP connection timed out." };
    case "EPROTO":
      return { kind: "tls", message: "TLS handshake failed — is the endpoint really https?" };
    default:
      break;
  }
  if (/certificate|self[- ]signed|CERT_|SSL|TLS/i.test(code || causeMessage)) {
    return { kind: "tls", message: `TLS error: ${causeMessage}` };
  }
  return { kind: "network", message: causeMessage };
}

interface Attempt {
  url: string;
  latencyMs: number;
  status?: number;
  body?: unknown;
  transportError?: { kind: ConnectionErrorKind; message: string };
}

async function attempt(url: string, timeoutMs: number): Promise<Attempt> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - startedAt);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { url, latencyMs, status: response.status, body };
  } catch (err) {
    return { url, latencyMs: Math.round(performance.now() - startedAt), transportError: classifyTransportError(err) };
  }
}

/** IDTA-01002 `ServiceDescription` is `{ profiles: string[] }`; anything else is not one. */
function readProfiles(body: unknown): string[] | undefined {
  const profiles = (body as { profiles?: unknown } | undefined)?.profiles;
  if (!Array.isArray(profiles)) return undefined;
  const strings = profiles.filter((p): p is string => typeof p === "string");
  return strings.length > 0 ? strings : undefined;
}

export async function probeConnection(request: ConnectionTestRequest): Promise<ConnectionTestResult> {
  const checkedAt = new Date().toISOString();

  let baseUrl: string;
  try {
    baseUrl = normaliseBaseUrl(request.baseUrl);
  } catch (err) {
    const message = (err as Error).message;
    return {
      reachable: false,
      probedUrl: request.baseUrl ?? "",
      probedEndpoint: "description",
      detail: message,
      error: { kind: "invalid-url", message },
      checkedAt,
    };
  }

  const timeoutMs = clampTimeoutSeconds(request.timeoutSeconds) * 1000;
  const description = await attempt(`${baseUrl}/description`, timeoutMs);
  const base = { probedUrl: description.url, probedEndpoint: "description" as const, checkedAt };

  if (description.transportError) {
    return {
      ...base,
      reachable: false,
      latencyMs: description.latencyMs,
      detail: description.transportError.message,
      error: description.transportError,
    };
  }

  const status = description.status as number;

  if (status >= 200 && status < 300) {
    const profiles = readProfiles(description.body);
    return {
      ...base,
      reachable: true,
      httpStatus: status,
      latencyMs: description.latencyMs,
      profiles,
      detail: profiles
        ? `HTTP ${status} in ${description.latencyMs} ms · advertises ${profiles.length} profile${profiles.length === 1 ? "" : "s"}.`
        : `HTTP ${status} in ${description.latencyMs} ms, but the payload is not an IDTA ServiceDescription (no "profiles") — check that the base URL points at the API root.`,
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      reachable: true,
      httpStatus: status,
      latencyMs: description.latencyMs,
      detail: `HTTP ${status} in ${description.latencyMs} ms — the server is up but rejected an unauthenticated request. Kaigara has no credentials for this connection yet.`,
    };
  }

  // Not every deployment exposes /description; fall back to the collection endpoint that every
  // AAS repository has before declaring the server unreachable.
  if (status === 404 || status === 405 || status === 501) {
    const shells = await attempt(`${baseUrl}/shells?limit=1`, timeoutMs);
    const shellsBase = { probedUrl: shells.url, probedEndpoint: "shells" as const, checkedAt };

    if (shells.transportError) {
      return {
        ...shellsBase,
        reachable: false,
        latencyMs: shells.latencyMs,
        detail: shells.transportError.message,
        error: shells.transportError,
      };
    }
    const shellsStatus = shells.status as number;
    if ((shellsStatus >= 200 && shellsStatus < 300) || shellsStatus === 401 || shellsStatus === 403) {
      return {
        ...shellsBase,
        reachable: true,
        httpStatus: shellsStatus,
        latencyMs: shells.latencyMs,
        detail: `/description answered HTTP ${status}; /shells answered HTTP ${shellsStatus} in ${shells.latencyMs} ms. The server is reachable but does not advertise its conformance profiles.`,
      };
    }
    return {
      ...shellsBase,
      reachable: false,
      httpStatus: shellsStatus,
      latencyMs: shells.latencyMs,
      detail: `Neither /description (HTTP ${status}) nor /shells (HTTP ${shellsStatus}) answered as an AAS API — check the base URL.`,
      error: { kind: "http", message: `HTTP ${shellsStatus} from ${shells.url}` },
    };
  }

  return {
    ...base,
    reachable: false,
    httpStatus: status,
    latencyMs: description.latencyMs,
    detail: `Server answered HTTP ${status} in ${description.latencyMs} ms.`,
    error: { kind: "http", message: `HTTP ${status} from ${description.url}` },
  };
}
