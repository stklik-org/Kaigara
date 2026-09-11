import type { LlmConfig, LlmProviderId } from "./llmConfig";

/**
 * The provider registry behind the LLM settings dialog. One entry per supported API; each knows
 * its default endpoint, how to authenticate, and how to do the two things the dialog needs:
 *
 *  1. **check the key** — a cheap authenticated GET that answers 200 for a good key and 401/403
 *     for a bad one, and
 *  2. **list callable models** — so the user picks from what their key can actually reach rather
 *     than typing a model id blind.
 *
 * For every provider here a single endpoint does both: its "list models" route is authenticated,
 * so a 200 with a model array *is* the key check. Hugging Face additionally has `whoami-v2`, which
 * is used first because it returns the account name — a friendlier confirmation than a bare list.
 *
 * These calls go directly from the browser. All three APIs send permissive CORS headers for these
 * GET endpoints (it is how the official browser SDKs work), so no backend hop is required for the
 * settings flow. The generation call itself can stay browser-side too, or move behind a backend
 * passthrough later without changing this file — see `llmClient.ts`.
 */
export interface VerifyResult {
  ok: boolean;
  /** One line safe to show verbatim: the account/org name on success, the failure reason on error. */
  detail: string;
  /** Chat-capable model ids the key can reach, sorted. May be empty if the provider does not
   *  enumerate them, in which case the dialog falls back to free text. */
  models: string[];
}

export interface LlmProviderDef {
  id: LlmProviderId;
  label: string;
  defaultBaseUrl: string;
  /** Placeholder shown in the key field. */
  keyHint: string;
  /** Where the user creates a key. */
  keyUrl: string;
  /** Extra hint under the model picker (e.g. what "warm" means for Hugging Face). */
  modelHint?: string;
  verify(config: LlmConfig, signal?: AbortSignal): Promise<VerifyResult>;
}

function baseOf(config: LlmConfig, fallback: string): string {
  const trimmed = config.baseUrl?.trim();
  return (trimmed && trimmed.replace(/\/+$/, "")) || fallback;
}

/** Narrows a fetch failure (offline, DNS, CORS) from an HTTP error response. */
async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(
      `Could not reach ${new URL(url).host}. Check the network, the base URL, or whether a proxy is blocking the request.`,
      { cause: error },
    );
  }
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

function authFailure(status: number, body: unknown, text: string): string {
  const message =
    (body as { error?: { message?: string } | string })?.error &&
    (typeof (body as { error: { message?: string } | string }).error === "string"
      ? (body as { error: string }).error
      : (body as { error: { message?: string } }).error.message);
  if (status === 401 || status === 403) return `Key rejected (HTTP ${status})${message ? ` — ${message}` : ""}.`;
  return `Provider answered HTTP ${status}${message ? ` — ${message}` : text ? ` — ${text.slice(0, 200)}` : ""}.`;
}

/** OpenAI-style `{ data: [{ id }] }`, sorted, newest-looking first is left to the caller. */
function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string")
    .sort((a, b) => a.localeCompare(b));
}

export const LLM_PROVIDERS: Record<LlmProviderId, LlmProviderDef> = {
  huggingface: {
    id: "huggingface",
    label: "Hugging Face",
    // The Inference Providers router — OpenAI-compatible, and what `/v1/models` + `/v1/chat/completions` hang off.
    defaultBaseUrl: "https://router.huggingface.co/v1",
    keyHint: "hf_………",
    keyUrl: "https://huggingface.co/settings/tokens",
    modelHint: "Models served through the Inference Providers router. Pick an instruct / chat model.",
    async verify(config, signal) {
      const key = config.apiKey.trim();
      // whoami lives on the hub host, not the router — it gives the account name for a nicer confirmation.
      const who = await getJson(
        "https://huggingface.co/api/whoami-v2",
        { Authorization: `Bearer ${key}` },
        signal,
      );
      if (!who.response.ok) {
        return { ok: false, detail: authFailure(who.response.status, who.body, who.text), models: [] };
      }
      const name =
        (who.body as { name?: string; fullname?: string })?.fullname ||
        (who.body as { name?: string })?.name ||
        "authenticated";

      const list = await getJson(
        `${baseOf(config, this.defaultBaseUrl)}/models`,
        { Authorization: `Bearer ${key}` },
        signal,
      );
      if (!list.response.ok) {
        // Key is valid (whoami passed); the router just would not enumerate — let the user type a model.
        return {
          ok: true,
          detail: `Key valid — signed in as ${name}. Model list unavailable (HTTP ${list.response.status}); enter a model id manually.`,
          models: [],
        };
      }
      return { ok: true, detail: `Key valid — signed in as ${name}.`, models: modelIds(list.body) };
    },
  },

  openai: {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyHint: "sk-………",
    keyUrl: "https://platform.openai.com/api-keys",
    modelHint: "Chat-completions models. gpt-4o-mini is a good default for this task.",
    async verify(config, signal) {
      const list = await getJson(
        `${baseOf(config, this.defaultBaseUrl)}/models`,
        { Authorization: `Bearer ${config.apiKey.trim()}` },
        signal,
      );
      if (!list.response.ok) {
        return { ok: false, detail: authFailure(list.response.status, list.body, list.text), models: [] };
      }
      const models = modelIds(list.body).filter((id) => /^(gpt-|o[13]|chatgpt)/.test(id));
      return { ok: true, detail: `Key valid — ${models.length} chat models available.`, models };
    },
  },

  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    keyHint: "sk-ant-………",
    keyUrl: "https://console.anthropic.com/settings/keys",
    async verify(config, signal) {
      const list = await getJson(
        `${baseOf(config, this.defaultBaseUrl)}/models`,
        {
          "x-api-key": config.apiKey.trim(),
          "anthropic-version": "2023-06-01",
          // Required for the API to answer a browser origin at all.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        signal,
      );
      if (!list.response.ok) {
        return { ok: false, detail: authFailure(list.response.status, list.body, list.text), models: [] };
      }
      return { ok: true, detail: `Key valid — ${modelIds(list.body).length} models available.`, models: modelIds(list.body) };
    },
  },
};

export function providerDef(id: LlmProviderId): LlmProviderDef {
  return LLM_PROVIDERS[id];
}
