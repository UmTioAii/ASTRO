import type { Auditor } from "./audit";
import type { Ledger } from "./ledger";
import type { ChatMessage, Provider } from "./provider/types";
import type { ModelEntry } from "./registry";
import type { ToolExecutor } from "./tools/executor";

export interface SessionOptions {
  run: string;
  agent: string;
  credentialRef: string;
  quotaDomain: string;
  cwd: string;
  provider: Provider;
  model: ModelEntry;
  executor: ToolExecutor;
  ledger: Ledger;
  audit: Auditor;
  maxSteps: number;
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT =
  "Você é um agente de código; use as tools para inspecionar e alterar arquivos no diretório de trabalho.";

/** Erro lançado quando a sessão esgota `maxSteps` sem uma resposta final. */
export class MaxStepsError extends Error {
  constructor(maxSteps: number) {
    super(`sessão excedeu o limite de ${maxSteps} passos sem resposta final`);
    this.name = "MaxStepsError";
  }
}

/**
 * Executa uma sessão single-agent: ciclo de completion, execução de tools e
 * registro de uso no ledger até o modelo devolver uma resposta sem tool calls.
 */
export async function runSession(
  opts: SessionOptions,
  task: string,
): Promise<{ final: string; steps: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let step = 1; step <= opts.maxSteps; step++) {
    const response = await opts.provider.complete({
      model: opts.model.id,
      messages,
      tools: opts.executor.defs(),
    });

    opts.ledger.record(
      {
        run: opts.run,
        agent: opts.agent,
        provider: opts.model.provider,
        model: opts.model.id,
        credentialRef: opts.credentialRef,
        quotaDomain: opts.quotaDomain,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
      },
      opts.model.price,
    );

    if (response.toolCalls.length === 0) {
      return { final: response.content, steps: step };
    }

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const result = await opts.executor.run(
        { cwd: opts.cwd, run: opts.run, agent: opts.agent },
        call,
      );
      messages.push({ role: "tool", content: result.output, toolCallId: call.id });
    }
  }

  throw new MaxStepsError(opts.maxSteps);
}
