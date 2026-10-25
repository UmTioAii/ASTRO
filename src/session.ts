import type { Auditor } from "./audit";
import { CallJournal } from "./call-id";
import { hashToolCalls, type Ledger } from "./ledger";
import { buildHandoffArtifact, HandoffError, type HandoffArtifactV1, type HandoffDraft } from "./handoff/types";
import type { ChatMessage, Provider } from "./provider/types";
import type { ModelEntry } from "./registry";
import { ToolExecutor } from "./tools/executor";
import type { AgentEntry } from "./registry";
import { redactSecrets } from "./sanitize-external";
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
  /** Ambiente do run; vai ao ToolContext do shell (default: `process.env` no run_command). */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
  agentProfile?: string;
  knownAgents?: readonly string[];
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
  draft: HandoffDraft;
}

/** Verifica se o output de uma tool é um handoff. */
function isHandoffResult(output: string): HandoffResult | null {
  try {
    const p = JSON.parse(output);
    if (p?.handoff === true && typeof p.to === "string" && typeof p.draft === "object" && p.draft !== null) return p as HandoffResult;
  } catch { /* não é JSON ou não é handoff */ }
  return null;
}

function assertKnownTarget(call: { name: string; arguments: string }, knownAgents: readonly string[] | undefined): void {
  if (call.name !== "handoff" || knownAgents === undefined) return;
  try {
    const { to } = JSON.parse(call.arguments) as { to?: unknown };
    if (typeof to === "string" && !knownAgents.includes(to))
      throw new HandoffError("handoff_target_not_found", `agent destino "${to}" não encontrado na configuração`);
  } catch (e) { if (e instanceof HandoffError) throw e; }
}

function budgetSpent(ledger: Ledger, run: string): { tokens: number; usd: number } {
  return ledger.readAll().reduce((acc, e) => e.run === run
    ? { tokens: acc.tokens + e.tokensIn + e.tokensOut, usd: acc.usd + (e.costUsd ?? 0) } : acc, { tokens: 0, usd: 0 });
}

function recordHandoffEvent(kind: "handoff.created" | "handoff.received", deps: { ledger: Ledger; audit: Auditor; run: string }, artifact: HandoffArtifactV1, agent: string) {
  const entry = deps.ledger.recordHandoff(kind, deps.run, artifact, { agent });
  deps.audit.append({ run: deps.run, agent, tipo: kind, payload: { handoff_id: entry.handoff_id, artifact: entry.artifact } });
  return entry;
}

/** Remove segredos do prompt antes de enviar ao provider (I-03). */
function safePrompt(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m, content: redactSecrets(m.content),
    ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls.map((c) => ({ ...c, arguments: redactSecrets(c.arguments) })) }),
  }));
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
  /** Journal por sessão (F-03): dedup de calls idênticos no mesmo step. */
  const journal = new CallJournal();
  const knownAgents = opts.knownAgents ?? [];

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
        messages: safePrompt(messages),
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
          callHashes: hashToolCalls(response.toolCalls),
        },
        opts.model.price,
      );

      if (response.toolCalls.length === 0) {
        opts.ledger.recordState(opts.run, "completed", { agent: opts.agent });
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
        assertKnownTarget(call, knownAgents);
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: opts.agent },
          stepSpan ?? rootSpan,
        );
        const result = await opts.executor.run(
          {
            cwd: opts.cwd,
            run: opts.run,
            agent: opts.agent,
            step,
            journal,
            knownAgents,
            ...(opts.env === undefined ? {} : { env: opts.env }),
            ...(opts.protectedPaths === undefined ? {} : { protectedPaths: opts.protectedPaths }),
            ...(opts.secretEnvNames === undefined ? {} : { secretEnvNames: opts.secretEnvNames }),
          },
          call,
        );
        tracer?.end(toolSpan, { isError: result.isError === true });
        messages.push({ role: "tool", content: result.output, toolCallId: call.id });

        // Detectar handoff no resultado
        const handoff = call.name === "handoff" ? isHandoffResult(result.output) : null;
        if (handoff) {
          const entry = recordHandoffEvent("handoff.created", { ledger: opts.ledger, audit: opts.audit, run: opts.run },
            buildHandoffArtifact({ run: opts.run, from: opts.agent, to: handoff.to, sourceStep: step,
              budgetSpent: budgetSpent(opts.ledger, opts.run), draft: handoff.draft,
              ...(opts.agentProfile === undefined ? {} : { fromProfile: opts.agentProfile }) }), opts.agent);
          tracer?.end(stepSpan, { handoff: redactSecrets(handoff.to) });
          tracer?.end(rootSpan, { status: "handoff", to: redactSecrets(handoff.to) });
          throw { name: "HandoffSignal", to: handoff.to, artifact: entry.artifact, step };
        }
      }
      tracer?.end(stepSpan);
    }
    tracer?.end(rootSpan, { status: "max_steps" });
    throw new MaxStepsError(opts.maxSteps);
  } catch (error) {
    if (!errorHasHandoffName(error)) {
      opts.ledger.recordState(opts.run, "interrupted", {
        agent: opts.agent,
        reason: error instanceof Error ? error.name : String(error),
      });
    }
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
  registry: { requireAgent(name: string): AgentEntry; getAgent(name: string): AgentEntry | undefined; listAgentNames?(): string[] };
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
  /** Ambiente do run; vai ao ToolContext do shell. */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
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
  /** Journal por sessão (F-03): dedup de calls idênticos no mesmo step, compartilhado entre executores. */
  const journal = new CallJournal();
  const knownAgents = opts.registry.listAgentNames?.();
  const handoffDeps = { ledger: opts.ledger, audit: opts.audit, run: opts.run };

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
        messages: safePrompt(messages),
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
          callHashes: hashToolCalls(response.toolCalls),
        },
        currentModel.price,
      );

      if (response.toolCalls.length === 0) {
        opts.ledger.recordState(opts.run, "completed", { agent: currentAgentName });
        tracer?.end(stepSpan, { "tool.calls": 0 });
        tracer?.end(rootSpan, { status: "ok", steps: step });
        return { final: response.content, steps: step, agentsUsed: agentsUsed.map(redactSecrets) };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      let handoffTriggered = false;
      for (const [callIndex, call] of response.toolCalls.entries()) {
        assertKnownTarget(call, knownAgents);
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: currentAgentName },
          stepSpan ?? rootSpan,
        );
        const result = await executor.run(
          {
            cwd: opts.cwd,
            run: opts.run,
            agent: currentAgentName,
            step,
            journal,
            ...(knownAgents === undefined ? {} : { knownAgents }),
            ...(opts.env === undefined ? {} : { env: opts.env }),
            ...(opts.protectedPaths === undefined ? {} : { protectedPaths: opts.protectedPaths }),
            ...(opts.secretEnvNames === undefined ? {} : { secretEnvNames: opts.secretEnvNames }),
          },
          call,
        );
        tracer?.end(toolSpan, { isError: result.isError === true });
        messages.push({ role: "tool", content: result.output, toolCallId: call.id });

        const handoff = call.name === "handoff" ? isHandoffResult(result.output) : null;
        if (handoff) {
          const toAgent = opts.registry.getAgent(handoff.to);
          if (toAgent === undefined) throw new HandoffError("handoff_target_not_found",
            `agent destino "${handoff.to}" não encontrado na configuração`);
          const entry = recordHandoffEvent("handoff.created", handoffDeps, buildHandoffArtifact({
            run: opts.run, from: currentAgentName, to: handoff.to, sourceStep: step, draft: handoff.draft,
            budgetSpent: budgetSpent(opts.ledger, opts.run),
            ...(currentAgent.profile === undefined ? {} : { fromProfile: currentAgent.profile }),
            ...(toAgent.profile === undefined ? {} : { toProfile: toAgent.profile }),
          }), currentAgentName);
          if (handoff.to !== currentAgentName) agentSteps = 0;
          currentAgentName = handoff.to;
          currentAgent = toAgent;
          currentMaxSteps = currentAgent.maxSteps ?? opts.baseMaxSteps;
          currentSystemPrompt = currentAgent.systemPrompt ?? opts.baseSystemPrompt;
          currentTools = currentAgent.tools ? new Set(currentAgent.tools) : new Set();
          agentsUsed.push(currentAgentName);
          opts.audit.append({ run: opts.run, agent: entry.artifact.from, tipo: "agent.switch",
            payload: { from: entry.artifact.from, to: entry.artifact.to, handoff_id: entry.handoff_id } });
          recordHandoffEvent("handoff.received", handoffDeps, entry.artifact, currentAgentName);
          messages.push({ role: "system", content: `[Sistema: handoff ${entry.handoff_id} para "${entry.artifact.to}": ${JSON.stringify(entry.artifact)}]` });
          for (const rest of response.toolCalls.slice(callIndex + 1))
            messages.push({ role: "tool", content: JSON.stringify({ skipped: "handoff" }), toolCallId: rest.id });
          handoffTriggered = true;
          break; // interrompe execução das outras tools deste step
        }
    }

    if (handoffTriggered) {
      tracer?.end(stepSpan, { handoff: redactSecrets(currentAgentName) });
      messages.push({ role: "system", content: `[Sistema: controle transferido para agent "${redactSecrets(currentAgentName)}"]` });
      continue; // próximo step com novo agent
    }
    tracer?.end(stepSpan);
    }

    tracer?.end(rootSpan, { status: "max_steps" });
    throw new MaxStepsError(opts.baseMaxSteps);
  } catch (error) {
    opts.ledger.recordState(opts.run, "interrupted", {
      agent: currentAgentName,
      reason: error instanceof Error ? error.name : String(error),
    });
    if (rootSpan !== undefined) {
      tracer?.end(rootSpan, {
        status: "error",
        "error.class": error instanceof Error ? error.name : String(error),
      });
    }
    throw error;
  }
}
