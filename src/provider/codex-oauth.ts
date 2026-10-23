import type { CodexTokens } from "./codex-auth";
import { readCodexAuth, refreshCodexTokens } from "./codex-auth";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ErrorClass,
  FetchLike,
  Provider,
  ToolCall,
} from "./types";
import { ProviderError } from "./types";

interface CodexOAuthProviderOptions {
  credentialsPath: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetchFn?: FetchLike;
  /** Relógio em milissegundos desde a epoch (default: `Date.now`). */
  now?: () => number;
}

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const EXPIRY_SKEW_SECONDS = 60;
const MAX_ERROR_DETAIL_LENGTH = 300;

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };

interface ResponsesMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: ResponsesContentPart[];
}

interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem;

interface WireTool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
}

interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: WireTool[];
  stream: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toInput(messages: ChatMessage[]): { instructions: string; input: ResponsesInputItem[] } {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    const role = message.role as string;
    if (role === "system" || role === "developer") {
      if (message.content.length > 0) instructions.push(message.content);
      continue;
    }
    if (role === "assistant") {
      if (message.content.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content,
      });
      continue;
    }
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message.content }],
    });
  }

  return { instructions: instructions.join("\n\n"), input };
}

function resolveCallId(
  event: Record<string, unknown>,
  callIdByItem: Map<string, string>,
  callIdByIndex: Map<number, string>,
): string | undefined {
  if (typeof event.call_id === "string" && event.call_id.length > 0) return event.call_id;

  const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
  if (itemId !== undefined) {
    const mapped = callIdByItem.get(itemId);
    if (mapped !== undefined) return mapped;
  }
  if (typeof event.output_index === "number") {
    const mapped = callIdByIndex.get(event.output_index);
    if (mapped !== undefined) return mapped;
  }
  return itemId;
}

function registerFunctionCall(
  event: Record<string, unknown>,
  done: boolean,
  calls: Map<string, ToolCall>,
  callIdByItem: Map<string, string>,
  callIdByIndex: Map<number, string>,
): void {
  const item = event.item;
  if (!isRecord(item) || item.type !== "function_call") return;

  const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined;
  if (callId === undefined) return;

  const existing = calls.get(callId);
  const name = typeof item.name === "string" && item.name.length > 0 ? item.name : (existing?.name ?? "");
  const finalArguments = typeof item.arguments === "string" ? item.arguments : undefined;
  const args = done
    ? (finalArguments ?? existing?.arguments ?? "")
    : (existing?.arguments ?? finalArguments ?? "");
  calls.set(callId, { id: callId, name, arguments: args });

  if (typeof item.id === "string" && item.id.length > 0) callIdByItem.set(item.id, callId);
  if (typeof event.output_index === "number") callIdByIndex.set(event.output_index, callId);
}

function eventErrorMessage(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : undefined;
  const error = isRecord(event.error)
    ? event.error
    : response !== undefined && isRecord(response.error)
      ? response.error
      : undefined;
  const message = error?.message ?? event.message;
  return typeof message === "string" && message.length > 0 ? message : "erro desconhecido";
}

function classifyStatus(status: number, text: string): ErrorClass {
  if (status === 429) {
    return text.toLowerCase().includes("insufficient_quota") ? "hard_quota" : "transient_rate_limit";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500) return "outage";
  if (status >= 400) return "invalid_request";
  return "outage";
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

function parseSse(text: string, redact: (value: string) => string): CompletionResponse {
  let content = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  let completed = false;
  const calls = new Map<string, ToolCall>();
  const callIdByItem = new Map<string, string>();
  const callIdByIndex = new Map<number, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const data = trimmed.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") continue;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new ProviderError("outage", "evento SSE inválido do provider Codex");
    }
    if (!isRecord(event) || typeof event.type !== "string") continue;

    if (event.type === "response.output_text.delta") {
      if (typeof event.delta === "string") content += event.delta;
      continue;
    }

    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      registerFunctionCall(event, event.type === "response.output_item.done", calls, callIdByItem, callIdByIndex);
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      const callId = resolveCallId(event, callIdByItem, callIdByIndex);
      if (callId !== undefined) {
        const call = calls.get(callId) ?? { id: callId, name: "", arguments: "" };
        if (typeof event.delta === "string") call.arguments += event.delta;
        calls.set(callId, call);
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      const callId = resolveCallId(event, callIdByItem, callIdByIndex);
      if (callId !== undefined && typeof event.arguments === "string") {
        const call = calls.get(callId) ?? { id: callId, name: "", arguments: "" };
        call.arguments = event.arguments;
        calls.set(callId, call);
      }
      continue;
    }

    if (event.type === "response.completed") {
      completed = true;
      const response = isRecord(event.response) ? event.response : undefined;
      const rawUsage = response !== undefined && isRecord(response.usage) ? response.usage : undefined;
      if (rawUsage !== undefined) {
        usage = {
          inputTokens: numberOrZero(rawUsage.input_tokens),
          outputTokens: numberOrZero(rawUsage.output_tokens),
        };
      }
      continue;
    }

    if (event.type === "response.failed" || event.type === "error") {
      throw new ProviderError(
        "outage",
        `provider Codex falhou: ${truncate(redact(eventErrorMessage(event)), MAX_ERROR_DETAIL_LENGTH)}`,
      );
    }
  }

  if (!completed) {
    throw new ProviderError("outage", "stream do provider Codex terminou sem response.completed");
  }

  return {
    content,
    toolCalls: [...calls.values()].filter((call) => call.name.length > 0),
    usage,
  };
}

/**
 * Provider do Codex via Responses API. Lê os tokens do `auth.json`
 * (somente leitura), renova em memória e consome o stream SSE.
 */
export class CodexOAuthProvider implements Provider {
  private readonly credentialsPath: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private tokens: CodexTokens | undefined;

  constructor(opts: CodexOAuthProviderOptions) {
    this.credentialsPath = opts.credentialsPath;
    this.url = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/responses`;
    this.headers = opts.headers ?? {};
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const tokens = await this.validTokens();

    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.headersFor(tokens),
        body: JSON.stringify(this.bodyFor(req)),
      });
    } catch {
      throw new ProviderError("outage", "falha de rede ao chamar o provider Codex");
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ProviderError(
        "outage",
        "falha ao ler a resposta do provider Codex",
        response.status,
      );
    }

    if (!response.ok) {
      throw this.errorFromResponse(response.status, text, tokens);
    }

    return parseSse(text, (value) => this.redact(value, tokens));
  }

  private async validTokens(): Promise<CodexTokens> {
    if (this.tokens === undefined) {
      this.tokens = readCodexAuth(this.credentialsPath);
    }
    if (this.tokens.expiresAt - this.now() / 1000 >= EXPIRY_SKEW_SECONDS) {
      return this.tokens;
    }

    this.tokens = await refreshCodexTokens(this.tokens, this.fetchFn);
    return this.tokens;
  }

  private headersFor(tokens: CodexTokens): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.headers)) {
      headers.set(name, value);
    }
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    headers.set("authorization", `Bearer ${tokens.accessToken}`);
    headers.set("chatgpt-account-id", tokens.accountId);
    return headers;
  }

  private bodyFor(req: CompletionRequest): ResponsesRequestBody {
    const { instructions, input } = toInput(req.messages);
    const body: ResponsesRequestBody = { model: req.model, input, stream: true };

    if (instructions.length > 0) body.instructions = instructions;
    if (req.tools !== undefined) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    return body;
  }

  private errorFromResponse(status: number, text: string, tokens: CodexTokens): ProviderError {
    const errClass = classifyStatus(status, text);
    const detail = truncate(this.redact(extractErrorDetail(text), tokens), MAX_ERROR_DETAIL_LENGTH);
    const message =
      `provider Codex respondeu HTTP ${status} (${errClass})` +
      (detail.length > 0 ? `: ${detail}` : "");
    return new ProviderError(errClass, message, status);
  }

  private redact(value: string, tokens: CodexTokens): string {
    let redacted = value;
    for (const secret of [tokens.accessToken, tokens.refreshToken]) {
      if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  }
}
