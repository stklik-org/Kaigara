import { readJson, writeJson } from "../storage";

/**
 * Client-side configuration for the "Generate scenario from description" LLM step.
 *
 * This is deliberately browser-local, like `connectionsClient`'s connection list: the orchestrator
 * does not own AI credentials yet, and a key the user pasted to try the feature should not need a
 * server round-trip to persist. It lives in `localStorage` under {@link STORAGE_KEY}; the API key
 * is stored in the clear, which is the same trust model as any browser-side token — acceptable for
 * a personal Hugging Face / OpenAI key on the user's own machine, and called out in the dialog.
 *
 * `provider` selects one entry from the registry in `llmProviders.ts`; `model` is the id the user
 * picked after a successful key check listed the callable models. `baseUrl` overrides the
 * provider's default endpoint — for an OpenAI-compatible proxy, an Azure deployment, a dedicated
 * Hugging Face Inference Endpoint, or a local runtime.
 */
export type LlmProviderId = "huggingface" | "openai" | "anthropic";

export interface LlmConfig {
  provider: LlmProviderId;
  apiKey: string;
  /** Chosen model id, or "" before one has been selected. */
  model: string;
  /** Optional endpoint override; the provider's default is used when absent or blank. */
  baseUrl?: string;
}

export const STORAGE_KEY = "kaigara.llm.v1";

const PROVIDER_IDS: readonly LlmProviderId[] = ["huggingface", "openai", "anthropic"];

export function defaultLlmConfig(): LlmConfig {
  return { provider: "huggingface", apiKey: "", model: "" };
}

function isLlmConfig(value: unknown): value is LlmConfig {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.provider === "string" &&
    (PROVIDER_IDS as readonly string[]).includes(v.provider) &&
    typeof v.apiKey === "string" &&
    typeof v.model === "string" &&
    (v.baseUrl === undefined || typeof v.baseUrl === "string")
  );
}

export function loadLlmConfig(): LlmConfig {
  return readJson(STORAGE_KEY, isLlmConfig) ?? defaultLlmConfig();
}

export function saveLlmConfig(config: LlmConfig): void {
  writeJson(STORAGE_KEY, config);
}

/** Whether the config is complete enough to attempt a generation call. */
export function isLlmConfigReady(config: LlmConfig): boolean {
  return config.apiKey.trim() !== "" && config.model.trim() !== "";
}
