import type { Auditor } from "./audit";
import type { Ledger } from "./ledger";
import type { ChatMessage, Provider } from "./provider/types";
import type { ModelEntry } from "./registry";
import { ToolExecutor } from "./tools/executor";
import type { AgentEntry } from "./registry";

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

/** Resultado de handoff detectado em tool result. */
interface HandoffResult {
  handoff: true;
  to: string;
  payload?: Record<string, unknown>;
}

/** Verifica se o output de uma tool é um handoff. */
function isHandoffResult(output: string): HandoffResult | null {
  try {
    const parsed = JSON.parse(output);
    if (parsed.handoff === true && typeof parsed.to === "string") {
      return { handoff: true, to: parsed.to, payload: parsed.payload };
    }
  } catch {
    // não é JSON ou não é handoff
  }
  return null;
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

      // Detectar handoff no resultado
      const handoff = isHandoffResult(result.output);
      if (handoff) {
        throw { name: "HandoffSignal", to: handoff.to, payload: handoff.payload, step };
      }
    }
  }

  throw new MaxStepsError(opts.maxSteps);
}

/** Opções para sessão multi-agent. */
export interface MultiAgentSessionOptions {
  run: string;
  credentialRef: string;
  quotaDomain: string;
  cwd: string;
  provider: Provider;
  registry: { requireAgent(name: string): AgentEntry; getAgent(name: string): AgentEntry | undefined };
  baseModel: ModelEntry;
  baseExecutor: ToolExecutor;
  ledger: Ledger;
  audit: Auditor;
  baseMaxSteps: number;
  baseSystemPrompt?: string;
  entryAgent: string;
}

/**
 * Executa uma sessão multi-agent com handoff.
 * Começa no `entryAgent` e troca de agent quando a tool `handoff` é chamada.
 */
export async function runMultiAgentSession(
  opts: MultiAgentSessionOptions,
  task: string,
): Promise<{ final: string; steps: number; agentsUsed: string[] }> {
  const agentsUsed: string[] = [];
  let currentAgentName = opts.entryAgent;
  let currentAgent = opts.registry.requireAgent(currentAgentName);
  agentsUsed.push(currentAgentName);

  let currentModel = opts.baseModel;
  let currentMaxSteps = currentAgent.maxSteps ?? opts.baseMaxSteps;
  let currentSystemPrompt = currentAgent.systemPrompt ?? opts.baseSystemPrompt;
  let currentTools: Set<string> = currentAgent.tools ? new Set(currentAgent.tools) : new Set();
  let step = 0;

  const messages: ChatMessage[] = [
    { role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  while (step < opts.baseMaxSteps) {
    step++;

    // Atualizar executor com tools do agent atual
    const executor = new ToolExecutor({
      tools: opts.baseExecutor.allTools,
      allow: [...currentTools],
      audit: opts.audit,
    });

    const response = await opts.provider.complete({
      model: currentModel.id,
      messages,
      tools: executor.defs(),
    });

    opts.ledger.record(
      {
        run: opts.run,
        agent: currentAgentName,
        provider: currentModel.provider,
        model: currentModel.id,
        credentialRef: opts.credentialRef,
        quotaDomain: opts.quotaDomain,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
      },
      currentModel.price,
    );

    if (response.toolCalls.length === 0) {
      return { final: response.content, steps: step, agentsUsed };
    }

    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    let handoffTriggered = false;
    for (const call of response.toolCalls) {
      const result = await executor.run(
        { cwd: opts.cwd, run: opts.run, agent: currentAgentName },
        call,
      );
      messages.push({ role: "tool", content: result.output, toolCallId: call.id });

      const handoff = isHandoffResult(result.output);
      if (handoff) {
        // Log agent switch
        opts.audit.append({
          run: opts.run,
          agent: currentAgentName,
          tipo: "agent.switch",
          payload: { from: currentAgentName, to: handoff.to, payload: handoff.payload },
        });

        // Trocar agent
        const newAgent = opts.registry.requireAgent(handoff.to);
        currentAgentName = handoff.to;
        currentAgent = newAgent;
        currentMaxSteps = newAgent.maxSteps ?? opts.baseMaxSteps;
        currentSystemPrompt = newAgent.systemPrompt ?? opts.baseSystemPrompt;
        currentTools = newAgent.tools ? new Set(newAgent.tools) : new Set();
        agentsUsed.push(currentAgentName);
        handoffTriggered = true;
        break; // interrompe execução das outras tools deste step
      }
    }

    if (handoffTriggered) {
      // Adicionar mensagem de sistema informando a troca
      messages.push({
        role: "system",
        content: `[Sistema: controle transferido para agent "${currentAgentName}"]`,
      });
      continue; // próximo step com novo agent
    }
  }

  throw new MaxStepsError(opts.baseMaxSteps);
}
