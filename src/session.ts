import type { Auditor } from "./audit";
import type { Ledger } from "./ledger";
import type { ChatMessage, Provider } from "./provider/types";
import type { ModelEntry } from "./registry";
import { ToolExecutor } from "./tools/executor";
import type { AgentEntry } from "./registry";
import type { SpanHandle, TracerLike } from "./tracing";
import { assertWithinQuota, type QuotaLimit } from "./quota";
import { assertAgentQuota, assertProjectBudget } from "./team";

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
  /** Tracing OTLP (F6-2); ausente = sem spans. */
  tracer?: TracerLike;
  /** Limites de quota por domínio (F6-3); ausente = sem enforcement. */
  quotaLimits?: Record<string, QuotaLimit>;
  /** Limites de time (F7-5): budget do projeto e quotas por agent. */
  teamLimits?: {
    projectBudgetUsd?: number;
    agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  };
}

const DEFAULT_SYSTEM_PROMPT =
  "Você é um agente de código; use as tools para inspecionar e alterar arquivos no diretório de trabalho.";

/** Erro lançado quando a sessão esgota `maxSteps` sem uma resposta final. */
export class MaxStepsError extends Error {
  constructor(maxSteps: number, message?: string) {
    super(message ?? `sessão excedeu o limite de ${maxSteps} passos sem resposta final`);
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
 * Com `tracer`, gera spans run → step → provider.complete/tool.exec (F6-2).
 */
export async function runSession(
  opts: SessionOptions,
  task: string,
): Promise<{ final: string; steps: number }> {
  const tracer = opts.tracer;
  const rootSpan = tracer?.start(
    "run",
    { agent: opts.agent, model: `${opts.model.provider}/${opts.model.id}`, run: opts.run },
  );
  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  try {
    for (let step = 1; step <= opts.maxSteps; step++) {
      // Quota (F6-3): bloqueia a chamada antes de gastar
      assertWithinQuota(opts.ledger, opts.quotaLimits ?? {}, opts.quotaDomain);
      // Team (F7-5): budget do projeto e quota do agent, somando o ledger inteiro
      if (opts.teamLimits?.projectBudgetUsd !== undefined) {
        assertProjectBudget(opts.ledger, opts.teamLimits.projectBudgetUsd);
      }
      if (opts.teamLimits?.agentQuotas !== undefined) {
        assertAgentQuota(opts.ledger, opts.teamLimits.agentQuotas, opts.agent);
      }
      const stepSpan = tracer?.start("step", { step, agent: opts.agent }, rootSpan);
      const providerSpan = tracer?.start(
        "provider.complete",
        { model: opts.model.id, provider: opts.model.provider },
        stepSpan ?? rootSpan,
      );
      const response = await opts.provider.complete({
        model: opts.model.id,
        messages,
        tools: opts.executor.defs(),
      });
      tracer?.end(providerSpan, {
        "tokens.in": response.usage.inputTokens,
        "tokens.out": response.usage.outputTokens,
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
        tracer?.end(stepSpan, { "tool.calls": 0 });
        tracer?.end(rootSpan, { status: "ok", steps: step });
        return { final: response.content, steps: step };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: opts.agent },
          stepSpan ?? rootSpan,
        );
        const result = await opts.executor.run(
          { cwd: opts.cwd, run: opts.run, agent: opts.agent },
          call,
        );
        tracer?.end(toolSpan, { isError: result.isError === true });
        messages.push({ role: "tool", content: result.output, toolCallId: call.id });

        // Detectar handoff no resultado
        const handoff = isHandoffResult(result.output);
        if (handoff) {
          tracer?.end(stepSpan, { handoff: handoff.to });
          tracer?.end(rootSpan, { status: "handoff", to: handoff.to });
          throw { name: "HandoffSignal", to: handoff.to, payload: handoff.payload, step };
        }
      }
      tracer?.end(stepSpan);
    }
    tracer?.end(rootSpan, { status: "max_steps" });
    throw new MaxStepsError(opts.maxSteps);
  } catch (error) {
    if (rootSpan !== undefined && !errorHasHandoffName(error)) {
      tracer?.end(rootSpan, {
        status: "error",
        "error.class": error instanceof Error ? error.name : String(error),
      });
    }
    throw error;
  }
}

function errorHasHandoffName(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "HandoffSignal"
  );
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
  /** Tracing OTLP (F6-2); ausente = sem spans. */
  tracer?: TracerLike;
  /** Limites de quota por domínio (F6-3); ausente = sem enforcement. */
  quotaLimits?: Record<string, QuotaLimit>;
  /** Limites de time (F7-5): budget do projeto e quotas por agent. */
  teamLimits?: {
    projectBudgetUsd?: number;
    agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  };
}

/**
 * Executa uma sessão multi-agent com handoff.
 * Começa no `entryAgent` e troca de agent quando a tool `handoff` é chamada.
 * Enforca `maxSteps` global (soma de todos) e por agent.
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
  let agentSteps = 0; // steps do agent atual

  const messages: ChatMessage[] = [
    { role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  const tracer = opts.tracer;
  const rootSpan = tracer?.start("run", {
    agent: opts.entryAgent,
    model: `${opts.baseModel.provider}/${opts.baseModel.id}`,
    run: opts.run,
    multi: true,
  });

  try {
    while (step < opts.baseMaxSteps) {
      // Verificar limite do agent atual
      if (agentSteps >= currentMaxSteps) {
        tracer?.end(rootSpan, { status: "error", "error.class": "MaxStepsError" });
        throw new MaxStepsError(
          currentMaxSteps,
          `agent "${currentAgentName}" excedeu o limite de ${currentMaxSteps} passos sem resposta final`,
        );
      }

      step++;
      agentSteps++;

      // Quota (F6-3): bloqueia a chamada antes de gastar
      assertWithinQuota(opts.ledger, opts.quotaLimits ?? {}, opts.quotaDomain);
      // Team (F7-5): budget do projeto e quota do agent corrente
      if (opts.teamLimits?.projectBudgetUsd !== undefined) {
        assertProjectBudget(opts.ledger, opts.teamLimits.projectBudgetUsd);
      }
      if (opts.teamLimits?.agentQuotas !== undefined) {
        assertAgentQuota(opts.ledger, opts.teamLimits.agentQuotas, currentAgentName);
      }

      // Atualizar executor com tools do agent atual
      const executor = new ToolExecutor({
        tools: opts.baseExecutor.allTools,
        allow: [...currentTools],
        audit: opts.audit,
      });

      const stepSpan = tracer?.start("step", { step, agent: currentAgentName }, rootSpan);
      const providerSpan = tracer?.start(
        "provider.complete",
        { model: currentModel.id, provider: currentModel.provider },
        stepSpan ?? rootSpan,
      );
      const response = await opts.provider.complete({
        model: currentModel.id,
        messages,
        tools: executor.defs(),
      });
      tracer?.end(providerSpan, {
        "tokens.in": response.usage.inputTokens,
        "tokens.out": response.usage.outputTokens,
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
        tracer?.end(stepSpan, { "tool.calls": 0 });
        tracer?.end(rootSpan, { status: "ok", steps: step });
        return { final: response.content, steps: step, agentsUsed };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      let handoffTriggered = false;
      for (const call of response.toolCalls) {
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: currentAgentName },
          stepSpan ?? rootSpan,
        );
        const result = await executor.run(
          { cwd: opts.cwd, run: opts.run, agent: currentAgentName },
          call,
        );
        tracer?.end(toolSpan, { isError: result.isError === true });
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
        agentSteps = 0; // reseta contador do novo agent
        agentsUsed.push(currentAgentName);
        handoffTriggered = true;
        break; // interrompe execução das outras tools deste step
      }
    }

    if (handoffTriggered) {
      tracer?.end(stepSpan, { handoff: currentAgentName });
      // Adicionar mensagem de sistema informando a troca
      messages.push({
        role: "system",
        content: `[Sistema: controle transferido para agent "${currentAgentName}"]`,
      });
      continue; // próximo step com novo agent
    }
    tracer?.end(stepSpan);
    }

    tracer?.end(rootSpan, { status: "max_steps" });
    throw new MaxStepsError(opts.baseMaxSteps);
  } catch (error) {
    if (rootSpan !== undefined) {
      tracer?.end(rootSpan, {
        status: "error",
        "error.class": error instanceof Error ? error.name : String(error),
      });
    }
    throw error;
  }
}
