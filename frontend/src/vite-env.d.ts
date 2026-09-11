/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only default for the shipped "twinsphere" connection — see
   *  `lib/api/twinsphereDevDefaults.ts`. Put real values in `.env.local` (gitignored), never in a
   *  committed `.env` file. */
  readonly VITE_TWINSPHERE_BASE_URL?: string;
  /** Header name to send the value below under. Defaults to `Authorization`. */
  readonly VITE_TWINSPHERE_AUTH_HEADER?: string;
  /** The full header value, verbatim — e.g. `Bearer <token>` or a raw API key, whatever this
   *  particular twinsphere instance expects. Sent as-is; Kaigara does no token exchange. */
  readonly VITE_TWINSPHERE_AUTH_VALUE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
