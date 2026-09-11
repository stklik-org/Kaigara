import { useMemo, type ReactNode } from "react";
import type { ApiClient } from "./client";
import { createDefaultApiClient } from "./defaultClient";
import { ApiContext } from "./ApiContext";

/** Defaults to `createDefaultApiClient()`. Pass a different `client` to swap in other
 *  implementations — no feature code changes, since every screen reads through `useApi()`. */
export function ApiProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const value = useMemo(() => client ?? createDefaultApiClient(), [client]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}
