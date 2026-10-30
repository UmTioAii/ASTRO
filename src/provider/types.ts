import type { AppliedCallProfile, CallSelection } from "../call-profile";

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
  /** Profile da model pool que originou a chamada (F-31); roteia o fallback de profile. */
  profile?: string;
  /** Escolha runtime do call profile (E1–E5); ausente = defaults do modelo. */
  call?: CallSelection;
  /** Recebe deltas de texto quando o provider suporta streaming (T3). */
  onToken?: (text: string) => void;
}

/** Uma troca de profile durante um completion (F-31); `reason` é a classe do erro. */
export interface FallbackRecord {
  profile: string;
  from_provider: string;
  to_provider: string;
  reason: ErrorClass;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** Nome do provider que atendeu (C6); fallback registra o real, não o wrapper. */
  provider?: string;
  /** Model id efetivo que atendeu (F-31): profile de fallback pode trocar o modelo. */
  model?: string;
  /** Trocas de profile até o atendimento (F-31); ausente quando o primário atendeu. */
  fallbacks?: FallbackRecord[];
  /** Perfil aplicado à chamada (E7): lvl/effort/thinking e proibidos removidos. */
  call?: AppliedCallProfile;
}

/** Contrato de um provider de chat completion. */
export interface Provider {
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
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
/** Requisições que já entregaram token: trocar de provider repetiria o texto. */
export const streamStarted = new WeakSet<object>();