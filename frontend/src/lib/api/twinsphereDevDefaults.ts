/**
 * Dev-only seed for the shipped "twinsphere" connection's target and credentials.
 *
 * `lib/mock/connections.ts` ships a `twinsphere` entry with a placeholder `baseUrl` and no
 * `headers`, because a real target and a real secret have no business in a file this repository
 * commits. For local development, `.env.local` (gitignored — never `.env` or `.env.example`) can
 * fill those in instead of retyping them into the Connect screen every time `localStorage` is
 * cleared:
 *
 *   VITE_TWINSPHERE_BASE_URL=https://twinsphere.example/api/v3
 *   VITE_TWINSPHERE_AUTH_HEADER=Authorization        # optional, defaults to Authorization
 *   VITE_TWINSPHERE_AUTH_VALUE=Bearer <secret>       # sent verbatim — no token exchange
 *
 * This only **fills gaps**, never overwrites: a `baseUrl` is replaced only while it is still empty
 * or the shipped placeholder, and a header is added only under a name the connection does not
 * already carry one for. Once the Connect screen's own form has written a real value, that value
 * is what "UI-definable" means and this stops touching it — editing `.env.local` after that has no
 * effect until the field is cleared again. Applied once, at connectionsClient init; a no-op when
 * no `VITE_TWINSPHERE_*` variable is set at all.
 */

import type { ServerConnection } from "@kaigara/shared-types";

const TWINSPHERE_ID = "twinsphere";
const PLACEHOLDER_BASE_URL = "https://twinsphere.example/api/v3";
const DEFAULT_HEADER_NAME = "Authorization";

export function applyTwinsphereDevDefaults(connections: ServerConnection[]): ServerConnection[] {
  const baseUrl = import.meta.env.VITE_TWINSPHERE_BASE_URL?.trim();
  const headerName = import.meta.env.VITE_TWINSPHERE_AUTH_HEADER?.trim() || DEFAULT_HEADER_NAME;
  const headerValue = import.meta.env.VITE_TWINSPHERE_AUTH_VALUE?.trim();

  if (!baseUrl && !headerValue) return connections;

  return connections.map((connection) => {
    if (connection.id !== TWINSPHERE_ID) return connection;

    const nextBaseUrl =
      baseUrl && (!connection.baseUrl || connection.baseUrl === PLACEHOLDER_BASE_URL) ? baseUrl : connection.baseUrl;

    const nextHeaders =
      headerValue && !connection.headers?.[headerName]
        ? { ...connection.headers, [headerName]: headerValue }
        : connection.headers;

    if (nextBaseUrl === connection.baseUrl && nextHeaders === connection.headers) return connection;
    return { ...connection, baseUrl: nextBaseUrl, headers: nextHeaders };
  });
}
