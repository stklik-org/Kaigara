/**
 * Dev-only seed for the shipped "twinsphere" connection's target and credentials.
 *
 * `lib/mock/connections.ts` ships a `twinsphere` entry with the real JKU tenant's `baseUrl` and
 * `oauth2` block already filled in — token URL, client ID and scope are this tenant's own, not
 * secrets — but a blank `clientSecret`, because a real secret has no business in a file this
 * repository commits. For local development, `.env.local` (gitignored — never `.env` or
 * `.env.example`) can fill that in instead of retyping it into the Connect screen's OAuth2 section
 * every time `localStorage` is cleared:
 *
 *   VITE_TWINSPHERE_CLIENT_SECRET=<the service-account's client secret>
 *
 *   # Legacy escape hatch, from before the Connect screen had an OAuth2 section: a static header,
 *   # sent verbatim with no token exchange — only applied if `oauth2` is not already configured.
 *   VITE_TWINSPHERE_BASE_URL=https://jku.cloud.twinsphere.io/api/v3
 *   VITE_TWINSPHERE_AUTH_HEADER=Authorization
 *   VITE_TWINSPHERE_AUTH_VALUE=Bearer <token>
 *
 * This only **fills gaps**, never overwrites: `clientSecret`/`baseUrl` are replaced only while
 * still blank or the shipped placeholder, and a header is added only under a name the connection
 * does not already carry one for. Once the Connect screen's own form has written a real value,
 * that value is what "UI-definable" means and this stops touching it — editing `.env.local` after
 * that has no effect until the field is cleared again. Applied once, at connectionsClient init; a
 * no-op when no `VITE_TWINSPHERE_*` variable is set at all.
 */

import type { ServerConnection } from "@kaigara/shared-types";

const TWINSPHERE_ID = "twinsphere-jku";
const PLACEHOLDER_BASE_URL = "https://twinsphere.example/api/v3";
const DEFAULT_HEADER_NAME = "Authorization";

export function applyTwinsphereDevDefaults(connections: ServerConnection[]): ServerConnection[] {
  const baseUrl = import.meta.env.VITE_TWINSPHERE_BASE_URL?.trim();
  const headerName = import.meta.env.VITE_TWINSPHERE_AUTH_HEADER?.trim() || DEFAULT_HEADER_NAME;
  const headerValue = import.meta.env.VITE_TWINSPHERE_AUTH_VALUE?.trim();
  const clientSecret = import.meta.env.VITE_TWINSPHERE_CLIENT_SECRET?.trim();

  if (!baseUrl && !headerValue && !clientSecret) return connections;

  return connections.map((connection) => {
    if (connection.id !== TWINSPHERE_ID) return connection;

    const nextBaseUrl =
      baseUrl && (!connection.baseUrl || connection.baseUrl === PLACEHOLDER_BASE_URL) ? baseUrl : connection.baseUrl;

    const nextOAuth2 =
      clientSecret && connection.oauth2 && !connection.oauth2.clientSecret
        ? { ...connection.oauth2, clientSecret }
        : connection.oauth2;

    // The static-header fallback only makes sense when OAuth2 isn't already the plan — otherwise
    // an env-var header would silently outrank the token exchange with no indication why.
    const nextHeaders =
      headerValue && !nextOAuth2 && !connection.headers?.[headerName]
        ? { ...connection.headers, [headerName]: headerValue }
        : connection.headers;

    if (nextBaseUrl === connection.baseUrl && nextHeaders === connection.headers && nextOAuth2 === connection.oauth2) {
      return connection;
    }
    return { ...connection, baseUrl: nextBaseUrl, headers: nextHeaders, oauth2: nextOAuth2 };
  });
}
