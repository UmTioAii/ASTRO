import { isAbortError } from "../abort";
import { redactSecrets } from "../sanitize-external";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ErrorClass,
  FetchLike,
  Provider,
  ToolCall,
} from "./types";
import { ProviderError, streamStarted } from "./types";

interface RetryOptions {
  maxAttempts?: number;
  windowMs?: number;
}

interface OpenAICompatProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  retry?: RetryOptions;
  fetchFn?: FetchLike;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 3;
const DEFAULT_WINDOW_MS = 60_000;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;
const BACKOFF_JITTER = 0.25;
const MAX_ERROR_DETAIL_LENGTH = 300;

const RETRYABLE: ReadonlySet<ErrorClass> = new Set(["transient_rate_limit", "outage"]);

/** Retry-After da resposta que originou o erro, quando presente. */
const retryAfterMsByError = new WeakMap<ProviderError, number>();

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface WireRequestBody {
  model: string;
  messages: WireMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }>;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toWireToolCalls(toolCalls: ToolCall[]): WireToolCall[] {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: { name: toolCall.name, arguments: toolCall.arguments },
  }));
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((message) => {
    // O NIM pode devolver/usar "developer"; o protocolo OpenAI usa "system".
    const role = (message.role as string) === "developer" ? "system" : message.role;
    const wire: WireMessage = { role, content: message.content };
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
    if (message.toolCalls !== undefined) wire.tool_calls = toWireToolCalls(message.toolCalls);
    return wire;
  });
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];

  const toolCalls: ToolCall[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.function)) return;
    const fn = entry.function;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (name.length === 0) return;

    const id =
      entry.id === undefined || entry.id === null || entry.id === ""
        ? `tool-${index}`
        : String(entry.id);
    const args = typeof fn.arguments === "string" ? fn.arguments : "";

    toolCalls.push({ id, name, arguments: args });
  });
  return toolCalls;
}

function parseCompletion(text: string): CompletionResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError("outage", "resposta do provider não é JSON válido");
  }

  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ProviderError("outage", 'resposta do provider sem "choices"');
  }

  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new ProviderError("outage", 'resposta do provider sem "choices[0].message"');
  }

  const message = first.message;
  const usage = isRecord(payload.usage) ? payload.usage : {};

  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: parseToolCalls(message.tool_calls),
    usage: {
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
  };
}

function extractErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof error === "string") return error;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Corpo não-JSON: usa o texto cru.
  }
  return trimmed;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  remainingMs: number,
): number | null {
  if (remainingMs <= 0) return null;

  const baseMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
  const delayMs = Math.max(baseMs * jitter, retryAfterMs ?? 0);

  return delayMs > remainingMs ? null : delayMs;
}

/**
 * Provider para endpoints OpenAI-compatible (NVIDIA NIM, OpenRouter e afins).
 * Autentica só pelo header `Authorization`, classifica falhas e faz retry
 * limitado apenas para erros transitórios/outage.
 */
export class OpenAICompatProvider implements Provider {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly headers: Headers;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly fetchFn: FetchLike;

  constructor(opts: OpenAICompatProviderOptions) {
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = opts.apiKey ?? "";
    this.fetchFn = opts.fetchFn ?? fetch;

    const headers = new Headers();
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    if (this.apiKey.length > 0) headers.set("authorization", `Bearer ${this.apiKey}`);
    this.headers = headers;

    const maxAttempts = opts.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxAttempts = Number.isFinite(maxAttempts)
      ? Math.min(MAX_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(maxAttempts)))
      : DEFAULT_MAX_ATTEMPTS;

    const windowMs = opts.retry?.windowMs ?? DEFAULT_WINDOW_MS;
    this.windowMs = Number.isFinite(windowMs) ? Math.max(0, windowMs) : DEFAULT_WINDOW_MS;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const startedAt = Date.now();

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request(req, signal);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // Já emitimos token: repetir duplicaria o texto no painel.
        if (streamStarted.has(req)) throw error;
        if (!RETRYABLE.has(error.errClass) || attempt >= this.maxAttempts) {
          throw error;
        }

        const remainingMs = this.windowMs - (Date.now() - startedAt);
        const delayMs = retryDelayMs(attempt, retryAfterMsByError.get(error), remainingMs);
        if (delayMs === null) throw error;

        await sleep(delayMs);
      }
    }
  }

  private async request(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.bodyFor(req)),
        signal,
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new ProviderError(
        "outage",
        `falha de rede ao chamar o provider: ${this.describe(error)}`,
      );
    }

    if (!response.ok) {
      let text = "";
      try {
        text = await response.text();
      } catch {
        // corpo de erro ilegível: mensagem usa só o status
      }
      throw this.errorFromResponse(response, text);
    }

    const sse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
    if (req.onToken !== undefined && sse) {
      return await this.streamResponse(req, response, req.onToken);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new ProviderError(
        "outage",
        `falha ao ler a resposta do provider: ${this.describe(error)}`,
        response.status,
      );
    }

    return parseCompletion(text);
  }

  /** Lê SSE (`data: {...}`) e entrega cada delta; devolve a resposta consolidada. */
  private async streamResponse(
    req: CompletionRequest,
    response: Response,
    onToken: (text: string) => void,
  ): Promise<CompletionResponse> {
    if (response.body === null) {
      throw new ProviderError("outage", "resposta sem corpo para streaming", response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let buffer = "";
    let content = "";
    let frames = 0;
    let anonymousToolCalls = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };

    const consume = (chunk: string): void => {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") continue;
        let payload: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: unknown;
        };
        try {
          payload = JSON.parse(data) as typeof payload;
        } catch {
          throw new ProviderError("outage", "stream do provider inválido");
        }
        frames += 1;
        if (payload.error !== undefined) {
          const raw =
            typeof payload.error === "object" && payload.error !== null && "message" in payload.error
              ? String((payload.error as { message?: unknown }).message ?? "")
              : "erro reportado";
          const detail = truncate(redactSecrets(this.redact(raw)), MAX_ERROR_DETAIL_LENGTH);
          throw new ProviderError("outage", `stream do provider: ${detail}`);
        }
        const delta = payload.choices?.[0]?.delta;
        if (typeof delta?.content === "string" && delta.content !== "") {
          content += delta.content;
          streamStarted.add(req);
          onToken(delta.content);
        }
        for (const call of delta?.tool_calls ?? []) {
          // Prioriza o id; sem id, index; sem ambos, ordem de chegada (ou a única call aberta).
          const byId = call.id !== undefined && call.id !== ""
            ? [...calls.entries()].find(([, value]) => value.id === call.id)?.[0]
            : undefined;
          let key: number;
          if (byId !== undefined) {
            key = byId;
          } else if (call.index !== undefined) {
            key = call.index;
          } else if (calls.size === 1 && (call.id === undefined || [...calls.values()][0]!.id === "")) {
            key = [...calls.keys()][0]!;
          } else {
            while (calls.has(anonymousToolCalls)) anonymousToolCalls++;
            key = anonymousToolCalls;
          }
          const current = calls.get(key) ?? { id: "", name: "", arguments: "" };
          if (call.id !== undefined && call.id !== "") current.id = call.id;
          if (call.function?.name !== undefined) current.name += call.function.name;
          if (call.function?.arguments !== undefined) current.arguments += call.function.arguments;
          calls.set(key, current);
        }
        if (payload.usage !== undefined) {
          usage = {
            inputTokens: payload.usage.prompt_tokens ?? usage.inputTokens,
            outputTokens: payload.usage.completion_tokens ?? usage.outputTokens,
          };
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") consume(buffer);
    if (frames === 0) throw new ProviderError("outage", "resposta de streaming vazia");

    const toolCalls = [...calls.entries()].map(([key, call]) => ({
      ...call,
      id: call.id === "" ? `call_${String(key)}` : call.id,
    }));
    return {
      content,
      toolCalls: toolCalls.filter((call) => call.name !== ""),
      usage,
    };
  }

  private bodyFor(req: CompletionRequest): WireRequestBody {
    const body: WireRequestBody = {
      model: req.model,
      messages: toWireMessages(req.messages),
    };
    if (req.tools !== undefined) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (req.onToken !== undefined) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private errorFromResponse(response: Response, text: string): ProviderError {
    const status = response.status;
    let errClass: ErrorClass;

    if (status === 429) {
      errClass = text.toLowerCase().includes("insufficient_quota")
        ? "hard_quota"
        : "transient_rate_limit";
    } else if (status === 401 || status === 403) {
      errClass = "auth";
    } else if (status === 400 || status === 404 || status === 422) {
      errClass = "invalid_request";
    } else if (status >= 500) {
      errClass = "outage";
    } else if (status >= 400) {
      errClass = "invalid_request";
    } else {
      errClass = "outage";
    }

    const detail = truncate(this.redact(extractErrorDetail(text)), MAX_ERROR_DETAIL_LENGTH);
    const message =
      `provider respondeu HTTP ${status} (${errClass})` + (detail.length > 0 ? `: ${detail}` : "");
    const error = new ProviderError(errClass, message, status);

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfterMs !== undefined) retryAfterMsByError.set(error, retryAfterMs);

    return error;
  }

  private describe(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return truncate(this.redact(detail), MAX_ERROR_DETAIL_LENGTH);
  }

  private redact(text: string): string {
    return this.apiKey.length === 0 ? text : text.split(this.apiKey).join("[REDACTED]");
  }
}
