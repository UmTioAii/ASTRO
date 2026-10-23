/** Mensagem no formato de chat do protocolo OpenAI. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** Chamada de tool devolvida pelo modelo. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Definição de uma tool exposta ao modelo. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

/** Contrato de um provider de chat completion. */
export interface Provider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ErrorClass =
  | "transient_rate_limit"
  | "hard_quota"
  | "auth"
  | "outage"
  | "invalid_request";

/** Erro classificado de provider; `status` é o HTTP status quando há resposta. */
export class ProviderError extends Error {
  errClass: ErrorClass;
  status?: number;

  constructor(errClass: ErrorClass, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.errClass = errClass;
    this.status = status;
  }
}
