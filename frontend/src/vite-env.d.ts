/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only default for the shipped "twinsphere-jku" connection — see
   *  `lib/api/twinsphereDevDefaults.ts`. Put real values in `.env.local` (gitignored), never in a
   *  committed `.env` file. */
  readonly VITE_TWINSPHERE_BASE_URL?: string;
  /** The service account's OAuth2 client secret — fills the gap left blank in
   *  `lib/mock/connections.ts` so it doesn't have to be retyped into the Connect screen's OAuth2
   *  section every time `localStorage` is cleared. */
  readonly VITE_TWINSPHERE_CLIENT_SECRET?: string;
  /** Legacy escape hatch, from before the Connect screen had an OAuth2 section — a static header,
   *  sent verbatim with no token exchange. Header name to send the value below under; defaults to
   *  `Authorization`. Only applied when `oauth2` isn't already configured. */
  readonly VITE_TWINSPHERE_AUTH_HEADER?: string;
  /** The full header value for the legacy escape hatch above, verbatim — e.g. `Bearer <token>` or
   *  a raw API key. */
  readonly VITE_TWINSPHERE_AUTH_VALUE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
