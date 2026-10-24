/**
 * ASTRO Provider SDK (F7-2): superfície pública para construir providers de
 * modelo — builtin, plugin ou pacote npm. Tudo que um provider precisa:
 * contratos, erros classificados, harness de teste e helper de factory.
 *
 * Uso em plugin:
 *   import { defineProviderFactory, ProviderError } from "./src/sdk/provider";
 *   export function definePlugin() {
 *     return {
 *       name: "meu-provider",
 *       providers: [defineProviderFactory("meu-kind", (rawConfig, env) => ({ ... }))],
 *     };
 *   }
 */
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ErrorClass,
  Provider,
  ToolCall,
  ToolDef,
} from "../provider/types";
import { ProviderError } from "../provider/types";

// Re-exports do contrato (superfície estável do SDK)
export type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ErrorClass,
  Provider,
  ToolCall,
  ToolDef,
};
export { ProviderError };

/** Fábrica de provider registrável em plugin (F7-1), keyed por kind. */
export interface ProviderFactory {
  kind: string;
  create(
    rawConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
  ): Provider;
}

/** Envolve uma função de criação no formato de factory de plugin. */
export function defineProviderFactory(
  kind: string,
  create: ProviderFactory["create"],
): ProviderFactory {
  return { kind, create };
}

/**
 * Harness de teste: provider com script determinístico de respostas.
 * Cada complete() consome a próxima resposta; esgotado, repete a última.
 * Erros do script são lançados (útil para testar retry/classificação).
 */
export function createMockProvider(
  script: Array<CompletionResponse | Error>,
): Provider & { calls: CompletionRequest[] } {
  let index = 0;
  const calls: CompletionRequest[] = [];
  return {
    calls,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      calls.push(req);
      const next = script[Math.min(index, script.length - 1)];
      index++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Resposta de conveniência para scripts de mock. */
export function mockResponse(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    content: "",
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    ...partial,
  };
}

/** Tool call de conveniência para scripts de mock. */
export function mockToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}