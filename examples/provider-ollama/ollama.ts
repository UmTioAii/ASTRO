/**
 * Exemplo de provider usando o ASTRO Provider SDK (F7-2): Ollama local.
 * ~90 linhas — referência de "criando um provider" (README § SDK).
 *
 * Config:
 *   "providers": { "ollama": { "kind": "ollama", "baseUrl": "http://localhost:11434/v1" } }
 *
 * Plugin:
 *   import { defineProviderFactory } from "./src/sdk/provider";
 *   export function definePlugin() {
 *     return { name: "astro-provider-ollama", providers: [ollamaFactory] };
 *   }
 */
import {
  ProviderError,
  defineProviderFactory,
  type CompletionResponse,
  type Provider,
  type ToolCall,
} from "../../src/sdk/provider";

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) return;
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } }).function;
    if (typeof fn?.name !== "string" || fn.name.length === 0) return;
    calls.push({
      id: `tool-${index}`,
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    });
  });
  return calls;
}

export const ollamaFactory = defineProviderFactory("ollama", (rawConfig, env) => {
  const baseUrl = String(rawConfig.baseUrl ?? "http://localhost:11434/v1").replace(/\/+$/, "");
  const credentialRef = typeof rawConfig.credentialRef === "string" ? rawConfig.credentialRef : undefined;
  const apiKey = credentialRef !== undefined ? env[credentialRef] : undefined;

  const provider: Provider = {
    async complete(req): Promise<CompletionResponse> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify({ model: req.model, messages: req.messages, tools: req.tools }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ProviderError("outage", `falha de rede ao chamar o Ollama: ${detail}`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError("auth", `Ollama respondeu HTTP ${response.status}`, response.status);
      }
      if (response.status === 429) {
        throw new ProviderError("transient_rate_limit", "Ollama rate limit", response.status);
      }
      if (!response.ok) {
        throw new ProviderError("invalid_request", `Ollama respondeu HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = payload.choices?.[0]?.message;
      return {
        content: typeof message?.content === "string" ? message.content : "",
        toolCalls: parseToolCalls(message?.tool_calls),
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
  return provider;
});