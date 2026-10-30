import type { Auditor } from "./audit";
import { isAbortError, throwIfAborted } from "./abort";
import { SwapDeniedError, type SwapApprover, type SwapRequest } from "./approval";
import { CallJournal } from "./call-id";
import { hashToolCalls, type HandoffEventKind, type Ledger } from "./ledger";
import { buildHandoffArtifact, HandoffError, handoffId, sanitizeHandoffArtifact, taskHash, type HandoffArtifactV1, type HandoffDraft } from "./handoff/types";
import { ackHandoff, scanHandoffs, readSourceRefs, type HandoffStatus } from "./handoff/lifecycle";
import { verifyHandoffIdentity } from "./handoff/verifier";
import { compactDraft, digestArtifacts } from "./handoff/compact";
import { DEFAULT_ACK_TIMEOUT_MS } from "./config";
import type { BudgetConfig, PriceConfig } from "./config";
import { budgetStatus, budgetWarningPayload, enforceBudget, BudgetExceededError, type BudgetDecider } from "./budget";
import type { ChatMessage, CompletionResponse, Provider } from "./provider/types";
import type { ModelEntry } from "./registry";
import { ToolExecutor } from "./tools/executor";
import type { AgentEntry } from "./registry";
import { redactSecrets } from "./sanitize-external";
import type { SpanHandle, TracerLike } from "./tracing";
import { assertWithinQuota, type QuotaLimit } from "./quota";
import { assertAgentQuota, assertProjectBudget } from "./team";
import { acquireAgentLock, findAgentLock, releaseAgentLock } from "./agent-lock";
import type { AppliedCallProfile, CallSelection } from "./call-profile";
import { effectiveOutputCap, type OutputLimitConfig } from "./output-limit";
import type { SpawnRegistry } from "./spawn";

/** Identidade efetiva de quem atendeu o completion (F-31d). */
export interface EffectiveIdentity {
  provider: string;
  model: string;
  credentialRef?: string;
  quotaDomain: string;
  price?: PriceConfig;
}

/** Resolve a identidade efetiva a partir do provider/model que responderam. */
export type IdentityResolver = (provider: string, model: string) => EffectiveIdentity | undefined;

export interface SessionOptions {
  run: string;
  agent: string;
  credentialRef?: string;
  quotaDomain: string;
  cwd: string;
  provider: Provider;
  model: ModelEntry;
  /** Escolha do call profile (E1–E5); ausente = defaults do modelo. */
  call?: CallSelection;
  /** Limite de saída por tool (CMP-10); ausente = default 8000/5%. */
  outputLimit?: OutputLimitConfig;
  /** Recebe deltas de texto quando o provider suporta streaming (T3). */
  onToken?: (text: string) => void;
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
  /** Budget (F-05): aviso/limite derivados do ledger (enforcement nas partes 3–4). */
  budget?: BudgetConfig;
  /** Decisor TTY do esgotamento (B4); ausente = não interativo (grava checkpoint e para). */
  budgetDecide?: BudgetDecider;
  /** Custo máximo da cadeia por chamada (B9); ausente = sem reserva. */
  budgetReserve?: (model: ModelEntry, profile?: string) => number;
  /** Ambiente do run; vai ao ToolContext do shell (default: `process.env` no run_command). */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
  agentProfile?: string;
  knownAgents?: readonly string[];
  /** Resolve a identidade efetiva quando o fallback troca provider/model (F-31d). */
  resolveIdentity?: IdentityResolver;
  /** Sinal de cancelamento para interromper a sessão (F-06). */
  signal?: AbortSignal;
  /** Histórico de conversa (T1): system + turnos anteriores; o user do turno é `task`. */
  history?: ChatMessage[];
}

export const DEFAULT_SYSTEM_PROMPT =
  "Você é um agente de código; use as tools para inspecionar e alterar arquivos no diretório de trabalho.";

/** Erro lançado quando a sessão esgota `maxSteps` sem uma resposta final. */
export class MaxStepsError extends Error {
  readonly maxSteps: number;
  constructor(maxSteps: number, message?: string) {
    super(message ?? `sessão excedeu o limite de ${maxSteps} passos sem resposta final`);
    this.name = "MaxStepsError";
    this.maxSteps = maxSteps;
  }
}

/**
 * Identidade de quem atendeu (F-31d): o resolver do app mapeia provider/model
 * para credencial, domínio de quota e preço; sem resolver, mantém a identidade
 * base (compatibilidade dos testes e chamadas diretas de sessão).
 */
function effectiveIdentityFor(
  resolve: IdentityResolver | undefined,
  response: CompletionResponse,
  fallbackModel: ModelEntry,
  credentialRef: string | undefined,
  quotaDomain: string,
): EffectiveIdentity {
  const provider = response.provider ?? fallbackModel.provider;
  const model = response.model ?? fallbackModel.id;
  const resolved = resolve?.(provider, model);
  if (resolved !== undefined) return resolved;
  return {
    provider,
    model,
    credentialRef,
    quotaDomain,
    ...(fallbackModel.price === undefined ? {} : { price: fallbackModel.price }),
  };
}

/** Resultado de handoff detectado em tool result. */
interface HandoffResult {
  handoff: true;
  to: string;
  draft: HandoffDraft;
  /** Caminhos citados pelo emissor; digeridos no created (F-25). */
  artifacts?: string[];
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
  const parsed = (() => { try { return JSON.parse(call.arguments) as { to?: unknown }; } catch { return {}; } })();
  if (typeof parsed.to === "string" && !knownAgents.includes(parsed.to)) throw new HandoffError("handoff_target_not_found", `agent destino "${parsed.to}" não encontrado na configuração`);
}

function budgetSpent(ledger: Ledger, run: string): { tokens: number; usd: number } {
  return ledger.readAll().reduce((acc, e) => e.run === redactSecrets(run)
    ? { tokens: acc.tokens + e.tokensIn + e.tokensOut, usd: acc.usd + (e.costUsd ?? 0) } : acc, { tokens: 0, usd: 0 });
}
function recordHandoffEvent(
  kind: HandoffEventKind,
  deps: { ledger: Ledger; audit: Auditor; run: string },
  artifact: HandoffArtifactV1,
  agent: string,
  extra?: { reason?: string },
) {
  // CAS (F-26): evento deduplicado devolve o existente sem repetir o audit
  if ((kind === "handoff.created" || kind === "handoff.received")
    && deps.ledger.readHandoffs().some((e) => e.kind === kind && e.handoff_id === handoffId(sanitizeHandoffArtifact(artifact)))) {
    return deps.ledger.recordHandoff(kind, deps.run, artifact, { agent, ...(extra ?? {}) });
  }
  const entry = deps.ledger.recordHandoff(kind, deps.run, artifact, { agent, ...(extra ?? {}) });
  deps.audit.append({ run: deps.run, agent, tipo: kind, payload: { handoff_id: entry.handoff_id, artifact: entry.artifact } });
  return entry;
}

/** Espera o ack do receptor com timeout (F-24); devolve "timeout" se estourou. */
async function awaitAck(perform: () => unknown, timeoutMs: number): Promise<"ok" | "timeout"> {
  const TIMEOUT = Symbol("ack_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); });
  try {
    const outcome = await Promise.race([Promise.resolve(perform()), timeout]);
    return outcome === TIMEOUT ? "timeout" : "ok";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Detalhe recuperado do ledger quando o nível compacto foi truncado (F-25). */
function resumeDetail(ledger: Ledger, artifact: HandoffArtifactV1): string {
  if (artifact.truncated !== true || artifact.source_refs === undefined) return "";
  return ` recuperação: ${JSON.stringify(readSourceRefs(ledger, artifact.source_refs))}`;
}
/** Remove segredos do prompt antes de enviar ao provider (I-03). */
const SECRET_KEY_NAME = /(token|secret|password|api[-_]?key|access[-_]?key)/i;

/** Redige mensagens estruturalmente (sem serializar/parsear JSON de novo). */
function scrubPrompt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPrompt);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_KEY_NAME.test(key) ? "[REDACTED]" : scrubPrompt(item),
    ]));
  }
  return typeof value === "string" ? redactSecrets(value) : value;
}

function safePrompt(messages: readonly ChatMessage[]): ChatMessage[] {
  return scrubPrompt(messages) as ChatMessage[];
}

/**
 * Executa uma sessão single-agent: ciclo de completion, execução de tools e
 * registro de uso no ledger até o modelo devolver uma resposta sem tool calls.
 * Com `tracer`, gera spans run → step → provider.complete/tool.exec (F6-2).
 */
export async function runSession(
  opts: SessionOptions,
  task: string,
): Promise<{ final: string; steps: number; messages: ChatMessage[] }> {
  const tracer = opts.tracer;
  const rootSpan = tracer?.start(
    "run",
    { agent: redactSecrets(opts.agent), model: `${opts.model.provider}/${opts.model.id}`, run: redactSecrets(opts.run) },
  );
  // Histórico de chat sempre começa com system: sem ele, usa o prompt da config
  const history = opts.history === undefined
    ? undefined
    : opts.history[0]?.role === "system"
      ? opts.history
      : [{ role: "system" as const, content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }, ...opts.history];
  const messages: ChatMessage[] = history === undefined
    ? [
        { role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: task },
      ]
    : [...history, { role: "user", content: task }];
  /** Journal por sessão (F-03): dedup de calls idênticos no mesmo step. */
  const journal = new CallJournal();
  const knownAgents = opts.knownAgents ?? [];
  let budgetWarned = false;
  /** Aviso B3: antes e depois de cada step (o último step também avisa). */
  const maybeWarnBudget = (agent: string): void => {
    if (opts.budget === undefined || budgetWarned) return;
    const status = budgetStatus(opts.budget, opts.ledger);
    if (!status.warning) return;
    budgetWarned = true;
    opts.audit.append({ run: opts.run, agent, tipo: "budget.warning", payload: budgetWarningPayload(status) });
  };
  let ceilingRecorded = false;
  /** Teto físico também é reavaliado após o uso (último step não escapa, B10). */
  const checkCeiling = (agent: string): void => {
    if (opts.budget?.hardCeilingUsd === undefined || ceilingRecorded) return;
    const status = budgetStatus(opts.budget, opts.ledger);
    if (status.spentUsd === null) {
      ceilingRecorded = true;
      opts.audit.append({ run: opts.run, agent, tipo: "budget.exceeded",
        payload: { scope: status.scope, spentUsd: status.spentUsd, limitUsd: status.limitUsd, reason: "unknown_price" } });
      opts.ledger.recordBudgetExceeded({ run: opts.run, agent, exceeded_choice: "stop" });
      throw new BudgetExceededError("unknown_price", status);
    }
    if (!status.ceilingHit) return;
    ceilingRecorded = true;
    opts.audit.append({ run: opts.run, agent, tipo: "budget.ceiling_hit",
      payload: { scope: status.scope, spentUsd: status.spentUsd, hardCeilingUsd: opts.budget.hardCeilingUsd } });
    opts.ledger.recordCeilingHit({ run: opts.run, agent, ceiling_hit: true });
    throw new BudgetExceededError("ceiling", status);
  };

  ensureAgentCreated(
    opts.ledger,
    opts.audit,
    opts.run,
    opts.agent,
    opts.model.id,
    { provider: opts.model.provider, ...(opts.credentialRef === undefined ? {} : { credentialRef: opts.credentialRef }) },
    opts.agentProfile,
  );

  try {
    let effectiveMaxSteps = opts.maxSteps;
    for (let step = 1; step <= effectiveMaxSteps; step++) {
      throwIfAborted(opts.signal); // ponto seguro: não inicia step após cancelamento (F-06)
      // Quota (F6-3): bloqueia a chamada antes de gastar
      assertWithinQuota(opts.ledger, opts.quotaLimits ?? {}, opts.quotaDomain);
      // Budget (B3): avisa uma vez ao cruzar warnAt
      maybeWarnBudget(opts.agent);
      // Budget (B4/B9): reserva a cadeia e checa o teto antes da chamada
      const reserveUsd = opts.budget === undefined ? 0 : (opts.budgetReserve?.(opts.model, opts.agentProfile) ?? 0);
      if (opts.budget !== undefined) {
        const choice = await enforceBudget({
          budget: opts.budget, ledger: opts.ledger, run: opts.run, agent: opts.agent, audit: opts.audit,
          reserveUsd,
          ...(opts.budgetDecide === undefined ? {} : { decide: opts.budgetDecide }),
        });
        // "baixar esforço" (B4): metade dos passos **restantes**, ao menos um
        if (choice === "lower_effort") {
          effectiveMaxSteps = Math.min(effectiveMaxSteps, step + Math.max(1, Math.floor((effectiveMaxSteps - step) / 2)));
        }
      }
      // Team (F7-5): budget do projeto e quota do agent, somando o ledger inteiro
      if (opts.teamLimits?.projectBudgetUsd !== undefined) {
        assertProjectBudget(opts.ledger, opts.teamLimits.projectBudgetUsd);
      }
      if (opts.teamLimits?.agentQuotas !== undefined) {
        assertAgentQuota(opts.ledger, opts.teamLimits.agentQuotas, opts.agent);
      }
      if (opts.budget !== undefined && reserveUsd > 0) {
        opts.ledger.recordBudgetReserved({ run: opts.run, agent: opts.agent, reserved: reserveUsd, detail: "call" });
      }
      const stepSpan = tracer?.start("step", { step, agent: redactSecrets(opts.agent) }, rootSpan);
      const providerSpan = tracer?.start(
        "provider.complete",
        { model: opts.model.id, provider: opts.model.provider },
        stepSpan ?? rootSpan,
      );
      const response = await opts.provider.complete({
        model: opts.model.id,
        messages: safePrompt(messages),
        tools: opts.executor.defs(),
        ...(opts.agentProfile === undefined ? {} : { profile: opts.agentProfile }),
        ...(opts.call === undefined ? {} : { call: opts.call }),
        ...(opts.onToken === undefined ? {} : { onToken: opts.onToken }),
      }, opts.signal);
      tracer?.end(providerSpan, {
        "tokens.in": response.usage.inputTokens,
        "tokens.out": response.usage.outputTokens,
      });

      const identity = effectiveIdentityFor(
        opts.resolveIdentity, response, opts.model, opts.credentialRef, opts.quotaDomain,
      );
      const usage = opts.ledger.record(
        {
          run: opts.run,
          agent: opts.agent,
          provider: identity.provider, // C6/F-31d: provider efetivo, não o wrapper
          model: identity.model,
          credentialRef: identity.credentialRef,
          quotaDomain: identity.quotaDomain,
          ...(opts.agentProfile === undefined ? {} : { profile: opts.agentProfile }),
          ...(response.fallbacks === undefined || response.fallbacks.length === 0
            ? {}
            : { fallbacks: response.fallbacks }),
          tokensIn: response.usage.inputTokens,
          tokensOut: response.usage.outputTokens,
          callHashes: hashToolCalls(response.toolCalls),
          ...callUsageFields(response.call),
        },
        identity.price,
      );
      if (opts.budget !== undefined && reserveUsd > 0) {
        opts.ledger.recordBudgetReleased({ run: opts.run, agent: opts.agent, released: reserveUsd,
          ...(usage.costUsd === null ? {} : { actual_cost: usage.costUsd }) });
      }
      maybeWarnBudget(opts.agent);
      checkCeiling(opts.agent);

      if (response.toolCalls.length === 0) {
        opts.ledger.recordState(opts.run, "completed", { agent: opts.agent });
        ensureAgentDestroyed(opts.ledger, opts.audit, opts.run, opts.agent, "completed");
        tracer?.end(stepSpan, { "tool.calls": 0 });
        tracer?.end(rootSpan, { status: "ok", steps: step });
        return { final: response.content, steps: step, messages };
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        throwIfAborted(opts.signal); // ponto seguro: nenhuma tool nova após cancelamento (I-16)
        assertKnownTarget(call, knownAgents);
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: redactSecrets(opts.agent) },
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
            allow: [...opts.executor.allow],
            maxSteps: effectiveMaxSteps,
            outputLimitTokens: effectiveOutputCap(opts.outputLimit, opts.model.context),
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
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
          // Compactação estruturada (F-25): nível compacto + source_refs do ledger
          const compacted = compactDraft(handoff.draft);
          const bounds = opts.ledger.seqBoundsOfRun(opts.run);
          const entry = recordHandoffEvent("handoff.created", { ledger: opts.ledger, audit: opts.audit, run: opts.run },
            buildHandoffArtifact({ run: opts.run, from: opts.agent, to: handoff.to, sourceStep: step,
              budgetSpent: budgetSpent(opts.ledger, opts.run), draft: compacted.draft,
              sourceRefs: { ledger_id: opts.ledger.id(), seq_start: bounds?.start ?? 1, seq_end: bounds?.end ?? 1 },
              ...(handoff.artifacts === undefined ? {} : { artifacts: digestArtifacts(opts.cwd, handoff.artifacts) }),
              compaction: compacted.compaction,
              ...(compacted.truncated ? { truncation: { truncated: true, originalTokens: compacted.originalTokens, returnedTokens: compacted.returnedTokens } } : {}),
              ...(opts.agentProfile === undefined ? {} : { fromProfile: opts.agentProfile }) }), opts.agent);
          // CAS (F-26): created já recebido em outro processo → sem reexecutar, segue o fluxo
          if (scanHandoffs(opts.ledger, opts.run).find((h) => h.handoff_id === entry.handoff_id)?.state === "completed") {
            continue;
          }
          tracer?.end(stepSpan, { handoff: redactSecrets(handoff.to) });
          tracer?.end(rootSpan, { status: "handoff", to: redactSecrets(handoff.to) });
          throw { name: "HandoffSignal", to: handoff.to, artifact: entry.artifact, step };
        }
      }
      tracer?.end(stepSpan);
    }
    tracer?.end(rootSpan, { status: "max_steps" });
    throw new MaxStepsError(effectiveMaxSteps);
  } catch (error) {
    // HandoffSignal transfere o controle ao caller e não grava run_state:
    // single+handoff não é retomável por planResume (multi-agent tem loop próprio).
    if (!errorHasHandoffName(error)) {
      const reason = interruptReason(error, opts.signal);
      try {
        opts.ledger.recordState(opts.run, "interrupted", {
          agent: opts.agent,
          reason,
        });
      } finally {
        releaseOnFailure(opts.ledger, opts.audit, opts.run, opts.agent, lockReason(error, opts.signal));
      }
    }
    if (rootSpan !== undefined && !errorHasHandoffName(error)) {
      tracer?.end(rootSpan, {
        status: "error",
        "error.class": interruptReason(error, opts.signal),
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

/** Campos de usage do call profile (E7); vazio quando o provider não ecoa. */
function callUsageFields(call: AppliedCallProfile | undefined): {
  lvl?: number;
  effort?: string;
  thinking?: string;
  "param.stripped"?: AppliedCallProfile["stripped"];
} {
  if (call === undefined) return {};
  return {
    ...(call.lvl === undefined ? {} : { lvl: call.lvl }),
    ...(call.effort === undefined ? {} : { effort: call.effort }),
    ...(call.thinking === undefined ? {} : { thinking: call.thinking }),
    ...(call.stripped.length === 0 ? {} : { "param.stripped": call.stripped }),
  };
}

/** Razão registrada no `run_state interrupted`: abort vira "cancelled" (F-06). */
function interruptReason(error: unknown, signal?: AbortSignal): string {
  if (isAbortError(error, signal)) return "cancelled";
  if (error instanceof SwapDeniedError) return "swap_denied";
  if (error instanceof BudgetExceededError) return "budget_exceeded";
  return error instanceof Error ? error.name : String(error);
}

/** Razão do `agent.destroyed` ao liberar a conta; MaxSteps tem nome estável. */
function lockReason(error: unknown, signal?: AbortSignal): string {
  if (error instanceof MaxStepsError) return "max_steps";
  return interruptReason(error, signal);
}

/**
 * Libera a conta do agente quando o run termina em erro (A4): sem isso o
 * `agent.created` fica sem `destroyed` e o próximo run falha `account_locked`.
 * Falha na liberação não mascara o erro original; a varredura de órfãos cobre
 * processo morto (não uma falha de I/O no PID atual).
 */
function releaseOnFailure(
  ledger: Ledger,
  audit: Auditor,
  run: string,
  agentId: string,
  reason: string,
): void {
  try {
    ensureAgentDestroyed(ledger, audit, run, agentId, reason);
  } catch {
    // Ledger indisponível: preserva o erro que interrompeu o run.
  }
}

/** Está ativo? Mesma reconstrução usada pelo lock (identity não reativa destruído). */
function agentActive(ledger: Ledger, run: string, agentId: string): boolean {
  return findAgentLock(ledger, run, agentId) !== undefined;
}

export interface AgentIdentity {
  provider: string;
  /** Nome da variável; nunca o valor (I-03). */
  credentialRef?: string;
}

/** Garante um `agent.created` e o lock exclusivo da conta (idempotente; reabre agente já destruído - F-22). */
function ensureAgentCreated(
  ledger: Ledger,
  audit: Auditor,
  run: string,
  agentId: string,
  model: string,
  identity: AgentIdentity,
  profile?: string,
  parentAgentId?: string,
): void {
  if (agentActive(ledger, run, agentId)) return;
  acquireAgentLock(ledger, audit, {
    run,
    agent_id: agentId,
    session_id: run,
    model,
    provider: identity.provider,
    ...(identity.credentialRef === undefined ? {} : { credentialRef: identity.credentialRef }),
    ...(profile === undefined ? {} : { profile }),
    ...(parentAgentId === undefined ? {} : { parent_agent_id: parentAgentId }),
  });
}

/** Garante um `agent.destroyed` e libera o lock (só se ativo e nosso; ledger → audit, ADR-0008 A5). */
function ensureAgentDestroyed(ledger: Ledger, audit: Auditor, run: string, agentId: string, reason: string): void {
  const lock = findAgentLock(ledger, run, agentId);
  if (lock === undefined) return;
  // Lock de outro processo vivo não é nosso: a aquisição falhou e nada a liberar.
  if (lock.pid !== undefined && lock.pid !== process.pid) return;
  releaseAgentLock(ledger, audit, {
    run,
    agent_id: agentId,
    reason,
    ...(lock.pid === undefined ? {} : { pid: lock.pid }),
    seq: lock.seq,
  });
}

/** Opções para sessão multi-agent. */
export interface MultiAgentSessionOptions {
  run: string;
  credentialRef?: string;
  /** Identidade de credencial por modelo; default provider do modelo + credentialRef base. */
  identityFor?: (model: ModelEntry) => AgentIdentity;
  quotaDomain: string;
  cwd: string;
  provider: Provider;
  registry: { requireAgent(name: string): AgentEntry; getAgent(name: string): AgentEntry | undefined; listAgentNames?(): string[]; resolveModel?(agent: AgentEntry): ModelEntry };
  baseModel: ModelEntry;
  baseExecutor: ToolExecutor;
  ledger: Ledger;
  audit: Auditor;
  baseMaxSteps: number;
  baseSystemPrompt?: string;
  entryAgent: string;
  /** Tracing OTLP (F6-2); ausente = sem spans. */
  tracer?: TracerLike;
  /** Recebe deltas de texto quando o provider suporta streaming (T3). */
  onToken?: (text: string) => void;
  /** Limites de quota por domínio (F6-3); ausente = sem enforcement. */
  quotaLimits?: Record<string, QuotaLimit>;
  /** Limites de time (F7-5): budget do projeto e quotas por agent. */
  teamLimits?: {
    projectBudgetUsd?: number;
    agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  };
  /** Budget (F-05): aviso/limite derivados do ledger (enforcement nas partes 3–4). */
  budget?: BudgetConfig;
  /** Decisor TTY do esgotamento (B4); ausente = não interativo (grava checkpoint e para). */
  budgetDecide?: BudgetDecider;
  /** Custo máximo da cadeia por chamada (B9); ausente = sem reserva. */
  budgetReserve?: (model: ModelEntry, profile?: string) => number;
  /** Ambiente do run; vai ao ToolContext do shell. */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
  /** Timeout do ack de handoff (F-24, D-15); default 30000ms. */
  ackTimeoutMs?: number;
  /** Ack do receptor (F-24); default lê o artefato do ledger e grava received. */
  ackHandoff?: (artifact: HandoffArtifactV1, receiverAgent: string) => unknown;
  /** Resolve a identidade efetiva quando o fallback troca provider/model (F-31d). */
  resolveIdentity?: IdentityResolver;
  /** Sinal de cancelamento para interromper a sessão (F-06). */
  signal?: AbortSignal;
  /** Escolha do call profile (E1–E5); ausente = defaults do modelo. */
  call?: CallSelection;
  /** Limite de saída por tool (CMP-10); ausente = default 8000/5%. */
  outputLimit?: OutputLimitConfig;
  /** Subagentes nascidos em runtime (C4a); ausente = só agents declarados. */
  spawns?: SpawnRegistry;
  /** Gate de aprovação de troca (F-19): o runtime injeta; ausente = sem gate (componente interno). */
  approveSwap?: SwapApprover;
  /** Provider por modelo/agent (F-31d): sem ele, todos usam `provider`. */
  providerFor?: (model: ModelEntry, profile?: string) => Provider;
  /** Nome do agente corrente compartilhado com os wrappers (atribui swap.*). */
  activeAgent?: { name: string };
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
  /** Resolve o model do agent no instanciamento (F-29, ADR-0007): profile da pool ou model direto; sem resolvedor usa o base (compat). */
  const modelFor = (agent: AgentEntry): ModelEntry => opts.registry.resolveModel !== undefined ? opts.registry.resolveModel(agent) : opts.baseModel;
  const identityOf = (model: ModelEntry): AgentIdentity =>
    opts.identityFor?.(model) ?? {
      provider: model.provider,
      ...(model.provider === opts.baseModel.provider && opts.credentialRef !== undefined
        ? { credentialRef: opts.credentialRef }
        : {}),
    };

  let currentModel = modelFor(currentAgent);
  /** Gate de troca por handoff (F-19, I-08): só quando a identidade efetiva muda. */
  const approveHandoff = async (fromModel: ModelEntry, fromAgent: AgentEntry, toModel: ModelEntry, toAgent: AgentEntry): Promise<void> => {
    if (opts.approveSwap === undefined) return;
    if (fromModel.provider === toModel.provider && fromModel.id === toModel.id && fromAgent.profile === toAgent.profile) return;
    const request: SwapRequest = {
      run: opts.run,
      agent: currentAgentName,
      from: { provider: fromModel.provider, model: fromModel.id, ...(fromAgent.profile === undefined ? {} : { profile: fromAgent.profile }) },
      to: { provider: toModel.provider, model: toModel.id, ...(toAgent.profile === undefined ? {} : { profile: toAgent.profile }) },
      reason: "handoff",
    };
    if (!(await opts.approveSwap(request))) throw new SwapDeniedError(request, "denied");
  };
  let currentMaxSteps = currentAgent.maxSteps ?? opts.baseMaxSteps;
  let currentSystemPrompt = currentAgent.systemPrompt ?? opts.baseSystemPrompt;
  let step = 0;
  let agentSteps = 0; // steps do agent atual
  /** Teto de escopo do agent atual (I-02): máximo de tools disponíveis no baseExecutor. */
  let currentCeiling: Set<string> = new Set(opts.baseExecutor.allow);
  let currentTools: Set<string> = currentAgent.tools ? new Set(currentAgent.tools) : new Set();
  /** Handoff ack nesta sessão; falha pós-ack grava handoff.failed (F-24). */
  let activeHandoff: { handoff_id: string; artifact: HandoffArtifactV1 } | undefined;
  const ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const messages: ChatMessage[] = [
    { role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  /** Histórico por agent: o retorno do filho não apaga o contexto do orchestrator (A9). */
  const agentState = new Map<string, { messages: ChatMessage[]; systemPrompt?: string }>();
  const saveAgentState = (name: string): void => {
    agentState.set(name, { messages: [...messages], systemPrompt: currentSystemPrompt });
  };
  const restoreAgentState = (name: string): boolean => {
    const saved = agentState.get(name);
    if (saved === undefined) return false;
    messages.length = 0;
    messages.push(...saved.messages);
    currentSystemPrompt = saved.systemPrompt;
    return true;
  };
  /** Journal por sessão (F-03): dedup de calls idênticos no mesmo step, compartilhado entre executores. */
  const journal = new CallJournal();
  /** Agents resolvíveis: declarados + subagentes deste run (C4a). */
  const resolveAgent = (name: string): AgentEntry | undefined => {
    const declared = opts.registry.getAgent(name);
    if (declared !== undefined) return declared;
    const spawned = opts.spawns?.get(name);
    return spawned === undefined ? undefined : opts.spawns!.toAgentEntry(spawned, opts.baseSystemPrompt);
  };
  const knownFor = (name: string): string[] | undefined => {
    const spawned = opts.spawns?.get(name);
    // Filho só fala com o pai; declarado só fala com declarados + filhos próprios.
    if (spawned !== undefined) return [spawned.parent_agent_id];
    const declared = opts.registry.listAgentNames?.();
    const ownChildren = opts.spawns?.list()
      .filter((agent) => agent.parent_agent_id === name)
      .map((agent) => agent.agent_id) ?? [];
    if (declared === undefined && ownChildren.length === 0) return undefined;
    return [...new Set([...(declared ?? []), ...ownChildren])];
  };
  /** Fecha subagentes que sobraram ativos ao fim do run (A5). */
  const cleanupSpawns = (reason: string): void => {
    for (const spawned of opts.spawns?.list() ?? []) {
      ensureAgentDestroyed(opts.ledger, opts.audit, opts.run, spawned.agent_id, reason);
    }
  };
  let budgetWarned = false;
  /** Aviso B3: antes e depois de cada step (o último step também avisa). */
  const maybeWarnBudget = (agent: string): void => {
    if (opts.budget === undefined || budgetWarned) return;
    const status = budgetStatus(opts.budget, opts.ledger);
    if (!status.warning) return;
    budgetWarned = true;
    opts.audit.append({ run: opts.run, agent, tipo: "budget.warning", payload: budgetWarningPayload(status) });
  };
  let ceilingRecorded = false;
  /** Teto físico também é reavaliado após o uso (último step não escapa, B10). */
  const checkCeiling = (agent: string): void => {
    if (opts.budget?.hardCeilingUsd === undefined || ceilingRecorded) return;
    const status = budgetStatus(opts.budget, opts.ledger);
    if (status.spentUsd === null) {
      ceilingRecorded = true;
      opts.audit.append({ run: opts.run, agent, tipo: "budget.exceeded",
        payload: { scope: status.scope, spentUsd: status.spentUsd, limitUsd: status.limitUsd, reason: "unknown_price" } });
      opts.ledger.recordBudgetExceeded({ run: opts.run, agent, exceeded_choice: "stop" });
      throw new BudgetExceededError("unknown_price", status);
    }
    if (!status.ceilingHit) return;
    ceilingRecorded = true;
    opts.audit.append({ run: opts.run, agent, tipo: "budget.ceiling_hit",
      payload: { scope: status.scope, spentUsd: status.spentUsd, hardCeilingUsd: opts.budget.hardCeilingUsd } });
    opts.ledger.recordCeilingHit({ run: opts.run, agent, ceiling_hit: true });
    throw new BudgetExceededError("ceiling", status);
  };
  const handoffDeps = { ledger: opts.ledger, audit: opts.audit, run: opts.run, cwd: opts.cwd };
  /** Ack do receptor com timeout (F-24): hook de teste ou o ciclo padrão do ledger. */
  const ackWithTimeout = (h: { handoff_id: string; artifact: HandoffArtifactV1 }, receiver: string) =>
    awaitAck(() => (opts.ackHandoff !== undefined ? opts.ackHandoff(h.artifact, receiver) : ackHandoff(handoffDeps, h.handoff_id, receiver)), ackTimeoutMs);
  const ackTimeoutError = (h: { handoff_id: string; artifact: HandoffArtifactV1 }) => {
    recordHandoffEvent("handoff.ack_timeout", handoffDeps, h.artifact, h.artifact.from, { reason: `sem ack em ${ackTimeoutMs}ms` });
    return new HandoffError("handoff_ack_timeout", `handoff ${h.handoff_id} sem ack em ${ackTimeoutMs}ms`);
  };

  const tracer = opts.tracer;
  const rootSpan = tracer?.start("run", {
    agent: redactSecrets(opts.entryAgent),
    model: `${currentModel.provider}/${currentModel.id}`,
    run: redactSecrets(opts.run),
    multi: true,
  });

  try {
    // Varredura de retomada (F-24): pendências do run no ledger do cwd corrente
    const resume = scanHandoffs(opts.ledger, opts.run).at(-1);
    if (resume !== undefined && resume.state === "failed") {
      // Falho permanente: reporta e não reexecuta (I-19)
      throw new Error(`handoff ${resume.handoff_id} falhou permanentemente e não será reexecutado${resume.reason === undefined ? "" : `: ${resume.reason}`}`);
    }
    if (resume !== undefined && resume.state === "pending") {
      const pending = resume;
      const toAgent = resolveAgent(pending.artifact.to);
      if (toAgent === undefined) throw new HandoffError("handoff_target_not_found", `agent destino "${pending.artifact.to}" não encontrado na configuração`);
      const toModel = modelFor(toAgent); // profile resolvido antes da retomada (F-29)
      await approveHandoff(currentModel, currentAgent, toModel, toAgent);
      saveAgentState(currentAgentName);
      currentModel = toModel;
      currentAgentName = pending.artifact.to;
      currentAgent = toAgent;
      currentMaxSteps = currentAgent.maxSteps ?? opts.baseMaxSteps;
      currentSystemPrompt = currentAgent.systemPrompt ?? opts.baseSystemPrompt;
      currentTools = currentAgent.tools ? new Set(currentAgent.tools) : new Set();
      if (opts.spawns?.get(currentAgentName) !== undefined) currentTools.delete("spawn_agent");
      // Teto de escopo na retomada = máximo do baseExecutor (I-02)
      // currentCeiling não muda — já é o máximo do baseExecutor
      if (!restoreAgentState(currentAgentName) && opts.spawns?.get(currentAgentName) !== undefined) {
        messages.length = 0;
        messages.push({ role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT });
      }
      if (messages.length === 0) {
        messages.push({ role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT });
      } else {
        messages[0] = { role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT };
      }
      // Verifier de identidade na retomada (F-26): o receptor começa em source_step+1
      verifyHandoffIdentity(
        { run: redactSecrets(opts.run), from: pending.artifact.from, to: redactSecrets(currentAgentName),
          taskHash: taskHash(pending.artifact.task, pending.artifact.objective), source_step: pending.artifact.source_step + 1 },
        pending.artifact,
      );
      // Receptor retomado confirma no início: lê, valida e grava received (F-24)
      if (await ackWithTimeout(pending, currentAgentName) === "timeout") throw ackTimeoutError(pending);
      opts.audit.append({ run: opts.run, agent: currentAgentName, tipo: "handoff.received", payload: { handoff_id: pending.handoff_id, artifact: pending.artifact } });
      activeHandoff = pending;
      const resumo = resumeDetail(opts.ledger, pending.artifact);
      messages.push({ role: "system", content: `[Sistema: handoff ${pending.handoff_id} para "${pending.artifact.to}": ${JSON.stringify(pending.artifact)}]${resumo}` });
      ensureAgentDestroyed(opts.ledger, opts.audit, opts.run, pending.artifact.from, "handoff");
      ensureAgentCreated(opts.ledger, opts.audit, opts.run, currentAgentName, currentModel.id, identityOf(currentModel), currentAgent.profile, pending.artifact.from);
    }
    ensureAgentCreated(opts.ledger, opts.audit, opts.run, currentAgentName, currentModel.id, identityOf(currentModel), currentAgent.profile);
    agentsUsed.push(currentAgentName);

    let effectiveBaseMaxSteps = opts.baseMaxSteps;
    while (step < effectiveBaseMaxSteps) {
      throwIfAborted(opts.signal); // ponto seguro: não inicia step após cancelamento (F-06)
      // Verificar limite do agent atual
      if (agentSteps >= currentMaxSteps) {
        tracer?.end(rootSpan, { status: "error", "error.class": "MaxStepsError" });
        throw new MaxStepsError(
          currentMaxSteps,
          `agent "${redactSecrets(currentAgentName)}" excedeu o limite de ${currentMaxSteps} passos sem resposta final`,
        );
      }

      step++;
      agentSteps++;

      // Quota (F6-3): bloqueia a chamada antes de gastar
      assertWithinQuota(opts.ledger, opts.quotaLimits ?? {}, opts.quotaDomain);
      // Budget (B3): avisa uma vez ao cruzar warnAt
      maybeWarnBudget(currentAgentName);
      // Budget (B4/B9): reserva a cadeia e checa o teto antes da chamada
      const reserveUsd = opts.budget === undefined ? 0 : (opts.budgetReserve?.(currentModel, currentAgent.profile) ?? 0);
      if (opts.budget !== undefined) {
        const choice = await enforceBudget({
          budget: opts.budget, ledger: opts.ledger, run: opts.run, agent: currentAgentName, audit: opts.audit,
          reserveUsd,
          ...(opts.budgetDecide === undefined ? {} : { decide: opts.budgetDecide }),
        });
        if (choice === "lower_effort") {
          effectiveBaseMaxSteps = Math.min(effectiveBaseMaxSteps, step + Math.max(1, Math.floor((effectiveBaseMaxSteps - step) / 2)));
        }
      }
      // Team (F7-5): budget do projeto e quota do agent corrente
      if (opts.teamLimits?.projectBudgetUsd !== undefined) {
        assertProjectBudget(opts.ledger, opts.teamLimits.projectBudgetUsd);
      }
      if (opts.teamLimits?.agentQuotas !== undefined) {
        assertAgentQuota(opts.ledger, opts.teamLimits.agentQuotas, currentAgentName);
      }
      if (opts.budget !== undefined && reserveUsd > 0) {
        opts.ledger.recordBudgetReserved({ run: opts.run, agent: currentAgentName, reserved: reserveUsd, detail: "call" });
      }

      // Atualizar executor com tools do agent atual
      const executor = new ToolExecutor({
        tools: opts.baseExecutor.allTools,
        allow: [...currentTools],
        ceiling: [...currentCeiling],
        audit: opts.audit,
      });

      const stepSpan = tracer?.start("step", { step, agent: redactSecrets(currentAgentName) }, rootSpan);
      const providerSpan = tracer?.start(
        "provider.complete",
        { model: currentModel.id, provider: currentModel.provider },
        stepSpan ?? rootSpan,
      );
      // Wrappers atribuem swap.* ao agente que está executando (F-19/I-04)
      if (opts.activeAgent !== undefined) opts.activeAgent.name = currentAgentName;
      const response = await (opts.providerFor?.(currentModel, currentAgent.profile) ?? opts.provider).complete({
        model: currentModel.id,
        messages: safePrompt(messages),
        tools: executor.defs(),
        ...(currentAgent.profile === undefined ? {} : { profile: currentAgent.profile }),
        ...(opts.call === undefined ? {} : { call: opts.call }),
        ...(opts.onToken === undefined ? {} : { onToken: opts.onToken }),
      }, opts.signal);
      tracer?.end(providerSpan, {
        "tokens.in": response.usage.inputTokens,
        "tokens.out": response.usage.outputTokens,
      });

      const identity = effectiveIdentityFor(
        opts.resolveIdentity, response, currentModel, opts.credentialRef, opts.quotaDomain,
      );
      const usage = opts.ledger.record(
        {
          run: opts.run,
          agent: currentAgentName,
          provider: identity.provider, // C6/F-31d: provider efetivo, não o wrapper
          model: identity.model,
          credentialRef: identity.credentialRef,
          quotaDomain: identity.quotaDomain,
          ...(currentAgent.profile === undefined ? {} : { profile: currentAgent.profile }),
          ...(response.fallbacks === undefined || response.fallbacks.length === 0
            ? {}
            : { fallbacks: response.fallbacks }),
          tokensIn: response.usage.inputTokens,
          tokensOut: response.usage.outputTokens,
          callHashes: hashToolCalls(response.toolCalls),
          ...callUsageFields(response.call),
        },
        identity.price,
      );
      if (opts.budget !== undefined && reserveUsd > 0) {
        opts.ledger.recordBudgetReleased({ run: opts.run, agent: currentAgentName, released: reserveUsd,
          ...(usage.costUsd === null ? {} : { actual_cost: usage.costUsd }) });
      }
      maybeWarnBudget(currentAgentName);
      checkCeiling(currentAgentName);

      if (response.toolCalls.length === 0) {
        opts.ledger.recordState(opts.run, "completed", { agent: currentAgentName });
        ensureAgentDestroyed(opts.ledger, opts.audit, opts.run, currentAgentName, "completed");
        cleanupSpawns("completed");
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
        throwIfAborted(opts.signal); // ponto seguro: nenhuma tool nova após cancelamento (I-16)
        const known = knownFor(currentAgentName);
        assertKnownTarget(call, known);
        const toolSpan = tracer?.start(
          "tool.exec",
          { tool: call.name, agent: redactSecrets(currentAgentName) },
          stepSpan ?? rootSpan,
        );
        const result = await executor.run(
          {
            cwd: opts.cwd,
            run: opts.run,
            agent: currentAgentName,
            step,
            journal,
            ...(known === undefined ? {} : { knownAgents: known }),
            allow: [...currentTools],
            maxSteps: currentMaxSteps,
            outputLimitTokens: effectiveOutputCap(opts.outputLimit, currentModel.context),
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
          const toAgent = resolveAgent(handoff.to);
          if (toAgent === undefined) throw new HandoffError("handoff_target_not_found",
            `agent destino "${handoff.to}" não encontrado na configuração`);
          const toModel = modelFor(toAgent); // profile do receptor resolvido ANTES do swap (F-29)
          await approveHandoff(currentModel, currentAgent, toModel, toAgent);
          // Compactação estruturada (F-25): nível compacto + source_refs do ledger
          const compacted = compactDraft(handoff.draft);
          const bounds = opts.ledger.seqBoundsOfRun(opts.run);
          const entry = recordHandoffEvent("handoff.created", handoffDeps, buildHandoffArtifact({
            run: opts.run, from: currentAgentName, to: handoff.to, sourceStep: step, draft: compacted.draft,
            budgetSpent: budgetSpent(opts.ledger, opts.run),
            sourceRefs: { ledger_id: opts.ledger.id(), seq_start: bounds?.start ?? 1, seq_end: bounds?.end ?? 1 },
            ...(handoff.artifacts === undefined ? {} : { artifacts: digestArtifacts(opts.cwd, handoff.artifacts) }),
            compaction: compacted.compaction,
            ...(compacted.truncated ? { truncation: { truncated: true, originalTokens: compacted.originalTokens, returnedTokens: compacted.returnedTokens } } : {}),
            ...(currentAgent.profile === undefined ? {} : { fromProfile: currentAgent.profile }),
            ...(toAgent.profile === undefined ? {} : { toProfile: toAgent.profile }),
          }), currentAgentName);
          // CAS (F-26, I-18): created já recebido em outro processo → devolve o existente, sem reexecutar
          if (scanHandoffs(opts.ledger, opts.run).find((h) => h.handoff_id === entry.handoff_id)?.state === "completed") continue;
          const emitterName = currentAgentName;
          // Respostas das tools puladas ficam no histórico do EMISSOR, antes do save.
          for (const rest of response.toolCalls.slice(callIndex + 1)) messages.push({ role: "tool", content: JSON.stringify({ skipped: "handoff" }), toolCallId: rest.id });
          // Teto de escopo permanece o máximo do baseExecutor (I-02: teto do sistema)
          // currentCeiling não muda — já é o máximo do baseExecutor
          saveAgentState(emitterName);
          if (handoff.to !== currentAgentName) agentSteps = 0;
          currentModel = toModel;
          currentAgentName = handoff.to;
          currentAgent = toAgent;
          currentMaxSteps = currentAgent.maxSteps ?? opts.baseMaxSteps;
          currentSystemPrompt = currentAgent.systemPrompt ?? opts.baseSystemPrompt;
          currentTools = currentAgent.tools ? new Set(currentAgent.tools) : new Set();
          if (opts.spawns?.get(currentAgentName) !== undefined) currentTools.delete("spawn_agent");
          if (!restoreAgentState(currentAgentName) && opts.spawns?.get(currentAgentName) !== undefined) {
            messages.length = 0;
            messages.push({ role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT });
          }
          // O system prompt é sempre o do agente que vai executar (inclusive 1ª visita).
          if (messages.length === 0) {
            messages.push({ role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT });
          } else {
            messages[0] = { role: "system", content: currentSystemPrompt ?? DEFAULT_SYSTEM_PROMPT };
          }
          // Self-handoff mantém o mesmo agente ativo: sem destroyed/created (F-22)
          if (handoff.to !== emitterName) {
            ensureAgentDestroyed(opts.ledger, opts.audit, opts.run, emitterName, "handoff");
            ensureAgentCreated(opts.ledger, opts.audit, opts.run, currentAgentName, currentModel.id, identityOf(currentModel), currentAgent.profile, emitterName);
          }
          agentsUsed.push(currentAgentName);
          opts.audit.append({ run: opts.run, agent: entry.artifact.from, tipo: "agent.switch",
            payload: { from: entry.artifact.from, to: entry.artifact.to, handoff_id: entry.handoff_id } });
          // Verifier de identidade na recepção (F-26): run|from|to|taskHash; source_step ±1
          verifyHandoffIdentity(
            { run: redactSecrets(opts.run), from: redactSecrets(emitterName), to: redactSecrets(currentAgentName),
              taskHash: taskHash(redactSecrets(handoff.draft.task), redactSecrets(handoff.draft.objective)), source_step: step },
            entry.artifact,
          );
          if (await ackWithTimeout(entry, currentAgentName) === "timeout") throw ackTimeoutError(entry);
          opts.audit.append({ run: opts.run, agent: currentAgentName, tipo: "handoff.received", payload: { handoff_id: entry.handoff_id, artifact: entry.artifact } });
          activeHandoff = entry;
          messages.push({ role: "system", content: `[Sistema: handoff ${entry.handoff_id} para "${entry.artifact.to}": ${JSON.stringify(entry.artifact)}]${resumeDetail(opts.ledger, entry.artifact)}` });
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
    throw new MaxStepsError(effectiveBaseMaxSteps);
  } catch (error) {
    // Falha pós-ack é terminal para o handoff: grava handoff.failed (F-24, I-19).
    // Cancelamento (F-06) NÃO grava failed: o artefato permanece no ledger para auditoria;
    // a retomada determinística do passo do receptor é S-14 (#131).
    if (
      activeHandoff !== undefined &&
      !(error instanceof HandoffError && error.code === "handoff_ack_timeout") &&
      // Negação de troca ou corte de budget não é falha do handoff já recebido:
      // o estado interrupted permite retomar e re-perguntar (I-08/I-17 + I-19).
      !(error instanceof SwapDeniedError) &&
      !(error instanceof BudgetExceededError) &&
      !isAbortError(error, opts.signal)
    ) {
      recordHandoffEvent("handoff.failed", handoffDeps, activeHandoff.artifact, currentAgentName, {
        reason: error instanceof Error ? error.name : String(error),
      });
    }
    const reason = interruptReason(error, opts.signal);
    try {
      opts.ledger.recordState(opts.run, "interrupted", {
        agent: currentAgentName,
        reason,
      });
    } finally {
      releaseOnFailure(opts.ledger, opts.audit, opts.run, currentAgentName, lockReason(error, opts.signal));
      cleanupSpawns(lockReason(error, opts.signal));
    }
    if (rootSpan !== undefined) {
      tracer?.end(rootSpan, {
        status: "error",
        "error.class": interruptReason(error, opts.signal),
      });
    }
    throw error;
  }
}

