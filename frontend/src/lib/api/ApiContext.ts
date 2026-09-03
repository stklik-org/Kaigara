import { createContext, useContext } from "react";
import type { ApiClient } from "./client";

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi() must be used within an <ApiProvider>");
  return ctx;
}
