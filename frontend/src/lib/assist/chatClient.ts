import type { LlmConfig } from "./llmConfig";
import { providerDef } from "./llmProviders";

/**
 * A provider-agnostic one-shot chat call — the seam the scenario generator sits on. `verify()` in
 * `llmProviders.ts` checks a key and lists models; this does the actual completion.
 *
 * Hugging Face is the primary target: its Inference Providers router speaks the OpenAI
 * `chat/completions` dialect, so one implementation covers Hugging Face and OpenAI, and Anthropic
 * gets a thin adapter (system prompt hoisted out of `messages`, different response shape).
 *
 * The call goes straight from the browser, like the settings check. That keeps the key in
 * `localStorage` and off the backend; the cost is the key living in page context and the target
 * needing permissive CORS (all three providers send it for these routes). A backend passthrough
 * can replace `createChatClient` later without touching the generator.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Lower is steadier; the generator wants near-deterministic structure. */
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider to constrain output to a JSON object where it supports it. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface ChatClient {
  complete(request: ChatRequest): Promise<string>;
}

function base(config: LlmConfig): string {
  const override = config.baseUrl?.trim().replace(/\/+$/, "");
  return override || providerDef(config.provider).defaultBaseUrl;
}

async function httpErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const err = (parsed as { error?: unknown; message?: string })?.error ?? (parsed as { message?: string })?.message;
  const detail =
    typeof err === "string" ? err : (err as { message?: string })?.message ?? (text ? text.slice(0, 300) : "");
  if (response.status === 401 || response.status === 403) {
    return `The provider rejected the API key (HTTP ${response.status}). Re-check it in settings.`;
  }
  if (response.status === 404) {
    return `Model not found (HTTP 404)${detail ? ` — ${detail}` : ""}. Pick a different model in settings.`;
  }
  return `The provider returned HTTP ${response.status}${detail ? ` — ${detail}` : ""}.`;
}

function readContent(data: unknown, path: "openai" | "anthropic"): string {
  const content =
    path === "openai"
      ? (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
      : (data as { content?: { text?: unknown }[] })?.content?.[0]?.text;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The model returned an empty response.");
  }
  return content;
}

/** OpenAI-compatible `POST {base}/chat/completions` — Hugging Face router and OpenAI both. */
function openAiCompatibleClient(config: LlmConfig): ChatClient {
  const url = `${base(config)}/chat/completions`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey.trim()}`,
  };

  return {
    async complete({ messages, temperature = 0.2, maxTokens = 4096, jsonMode = true, signal }) {
      const payload: Record<string, unknown> = {
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (jsonMode) payload.response_format = { type: "json_object" };

      let response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
      // Not every Hugging Face inference provider accepts response_format; drop it and retry once
      // rather than failing a model that would answer fine without the constraint.
      if (!response.ok && jsonMode && (response.status === 400 || response.status === 422)) {
        delete payload.response_format;
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
      }
      if (!response.ok) throw new Error(await httpErrorMessage(response));
      return readContent(await response.json(), "openai");
    },
  };
}

function anthropicClient(config: LlmConfig): ChatClient {
  const url = `${base(config)}/messages`;
  const headers = {
    "content-type": "application/json",
    "x-api-key": config.apiKey.trim(),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  return {
    async complete({ messages, temperature = 0.2, maxTokens = 4096, signal }) {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const rest = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, system, messages: rest, max_tokens: maxTokens, temperature }),
        signal,
      });
      if (!response.ok) throw new Error(await httpErrorMessage(response));
      return readContent(await response.json(), "anthropic");
    },
  };
}

export function createChatClient(config: LlmConfig): ChatClient {
  return config.provider === "anthropic" ? anthropicClient(config) : openAiCompatibleClient(config);
}
