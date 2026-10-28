/** Sessão de chat (T1): multi-turn sobre o mesmo run; a UI só fala com esta classe. */
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { runTask, shortTaskHash, type RunReport } from "../app";
import type { SwapApprover } from "../approval";
import { Auditor } from "../audit";
import type { BudgetDecider } from "../budget";
import { loadConfig, type AstroConfig } from "../config";
import type { ChatMessage } from "../provider/types";
import { Registry, type ModelEntry } from "../registry";
import { Ledger } from "../ledger";
import { DEFAULT_SYSTEM_PROMPT } from "../session";
import { guardContext } from "./context-guard";
import { isFatalSessionError } from "./session-errors";

export interface AgentSessionOptions {
  configPath: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Modelo inicial `provider/id`; default `agent.model` da config. */
  model?: string;
  systemPrompt?: string;
  /** Decisores interativos (TTY); ausentes mantêm pending/non-interactive. */
  approveSwap?: SwapApprover;
  onBudgetExceeded?: BudgetDecider;
}

export interface ProviderInfo {
  name: string;
  kind: string;
  credentialRef?: string;
  quotaDomain: string;
  models: string[];
}

export interface TurnResult {
  final: string;
  model: string;
  steps: number;
  /** Tokens do turno e acumulados da sessão. */
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number | null;
  contextTokens: number;
  contextLimit: number;
  contextRatio: number;
  warning: boolean;
  trimmed: boolean;
}

export interface SessionSnapshot {
  id: string;
  startedAt: string;
  model: string;
  messages: ChatMessage[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly #configPath: string;
  readonly #cwd: string;
  readonly #env: Record<string, string | undefined> | undefined;
  readonly #config: AstroConfig;
  readonly #registry: Registry;
  readonly #auditPath: string;
  readonly #ledger: Ledger;
  readonly #systemPrompt: string;
  readonly #approveSwap: SwapApprover | undefined;
  readonly #budgetDecider: BudgetDecider | undefined;
  #modelRef: string;
  #messages: ChatMessage[];
  #turns = 0;
  #steps = 0;
  #tokensIn = 0;
  #tokensOut = 0;
  #costUsd = 0;
  #costKnown = true;
  #closed = false;
  #fatal = false;
  #busy = false;

  constructor(opts: AgentSessionOptions) {
    this.#configPath = opts.configPath;
    this.#cwd = opts.cwd ?? process.cwd();
    this.#env = opts.env;
    this.#config = loadConfig(opts.configPath);
    this.#registry = new Registry(this.#config);
    this.#auditPath = resolvePath(this.#cwd, this.#config.paths.audit);
    this.#ledger = new Ledger(resolvePath(this.#cwd, this.#config.paths.ledger));
    this.#systemPrompt = opts.systemPrompt ?? this.#config.agent.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#approveSwap = opts.approveSwap;
    this.#budgetDecider = opts.onBudgetExceeded;
    this.#modelRef = opts.model ?? this.#config.agent.model;
    this.#registry.require(this.#modelRef); // falha cedo com modelo inexistente
    this.#messages = [{ role: "system", content: this.#systemPrompt }];
    this.#append("run.started", { session: true, model: this.modelName() });
  }

  /** Auditor novo por evento: outro Auditor (runTask) avança o seq no mesmo arquivo. */
  #append(tipo: string, payload: Record<string, unknown>): void {
    new Auditor(this.#auditPath).append({ run: this.id, agent: "default", tipo, payload });
  }

  get messages(): readonly ChatMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  get model(): string {
    return this.#modelRef;
  }

  /** Nome `provider/id` do modelo atual. */
  modelName(): string {
    const model = this.#registry.require(this.#modelRef);
    return `${model.provider}/${model.id}`;
  }

  listModels(): string[] {
    return this.#registry.list().map((model) => `${model.provider}/${model.id}`);
  }

  listProviders(): ProviderInfo[] {
    return Object.entries(this.#config.providers).map(([name, provider]) => ({
      name,
      kind: provider.kind,
      ...("credentialRef" in provider && typeof provider.credentialRef === "string"
        ? { credentialRef: provider.credentialRef }
        : {}),
      quotaDomain: provider.quotaDomain ?? "default",
      models: this.#config.models
        .filter((model) => model.provider === name && this.#registry.get(`${name}/${model.id}`)?.status === "active")
        .map((model) => model.id),
    }));
  }

  providerName(): string {
    return this.#registry.require(this.#modelRef).provider;
  }

  /** Troca de provider mantendo o id do modelo quando existir; senão o primeiro ativo. */
  setProvider(name: string): string {
    if (!(name in this.#config.providers)) throw new Error(`provider "${name}" não está configurado`);
    const candidates = this.#config.models
      .filter((model) => model.provider === name)
      .map((model) => this.#registry.get(`${name}/${model.id}`))
      .filter((model): model is ModelEntry => model !== undefined && model.status === "active");
    if (candidates.length === 0) throw new Error(`provider "${name}" não tem modelo ativo`);
    const currentId = this.#registry.require(this.#modelRef).id;
    const chosen = candidates.find((model) => model.id === currentId) ?? candidates[0]!;
    this.#modelRef = `${name}/${chosen.id}`;
    return this.#modelRef;
  }

  /** Troca o modelo do próximo turno (sem reiniciar); valida contra o registry. */
  setModel(ref: string): string {
    const model = this.#registry.require(ref);
    this.#modelRef = `${model.provider}/${model.id}`;
    return this.#modelRef;
  }

  /** Limpa o histórico preservando o system; acumulados da sessão continuam. */
  clear(): void {
    if (this.#busy) throw new Error("turno em andamento");
    this.#messages = [{ role: "system", content: this.#systemPrompt }];
  }

  /** Retoma uma sessão gravada: troca o system, mantém mensagens e acumulados. */
  resume(snapshot: SessionSnapshot): void {
    if (this.#busy) throw new Error("turno em andamento");
    if (this.#closed || this.#fatal) throw new Error("sessão de chat encerrada");
    this.#messages = [
      { role: "system", content: this.#systemPrompt },
      ...snapshot.messages.filter((message) => message.role !== "system").map((message) => ({ ...message })),
    ];
    if (this.#registry.get(snapshot.model)?.status === "active") this.#modelRef = snapshot.model;
    this.#turns = snapshot.turns;
    this.#tokensIn = snapshot.tokensIn;
    this.#tokensOut = snapshot.tokensOut;
    this.#steps = 0;
    this.#costKnown = snapshot.costUsd !== null;
    this.#costUsd = snapshot.costUsd ?? 0;
    this.#append("session.resumed", { turns: snapshot.turns, model: this.#modelRef });
  }

  async send(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    if (this.#closed || this.#fatal) throw new Error("sessão de chat encerrada");
    if (this.#busy) throw new Error("turno já em andamento");
    this.#busy = true;
    try {
      const before = this.#messages;
      const baseline = this.#ledger.readAll().length;
      const guard = guardContext([...before, { role: "user", content: prompt }], this.contextLimit());
      const history = guard.messages.slice(0, -1); // o último é o prompt deste turno
      this.#append("chat.prompt", { taskHash: shortTaskHash(prompt) });

      let report: RunReport;
      try {
        report = await runTask({
          configPath: this.#configPath,
          task: prompt,
          cwd: this.#cwd,
          ...(this.#env === undefined ? {} : { env: this.#env }),
          ...(signal === undefined ? {} : { signal }),
          runId: this.id,
          model: this.#modelRef,
          suppressRunEvents: true,
          history,
          ...(this.#approveSwap === undefined ? {} : { approveSwap: this.#approveSwap }),
          ...(this.#budgetDecider === undefined ? {} : { onBudgetExceeded: this.#budgetDecider }),
        });
      } catch (error) {
        // Uso gasto antes da falha fica no ledger: contabiliza no acumulado da sessão
        for (const entry of this.#ledger.readAll().slice(baseline)) {
          this.#tokensIn += entry.tokensIn;
          this.#tokensOut += entry.tokensOut;
          if (entry.costUsd === null) this.#costKnown = false;
          else this.#costUsd += entry.costUsd;
        }
        // Budget/swap negados encerram a sessão (checkpoint fica interrupted)
        if (isFatalSessionError(error)) this.#fatal = true;
        throw error;
      }

      this.#messages = [...(report.messages ?? guard.messages), { role: "assistant", content: report.final }];
      this.#turns++;
      this.#steps += report.steps;
      this.#tokensIn += report.tokensIn;
      this.#tokensOut += report.tokensOut;
      if (report.costUsd === null) this.#costKnown = false;
      else this.#costUsd += report.costUsd;

      return {
        final: report.final,
        model: report.model,
        steps: report.steps,
        tokensIn: report.tokensIn,
        tokensOut: report.tokensOut,
        costUsd: report.costUsd,
        totalTokensIn: this.#tokensIn,
        totalTokensOut: this.#tokensOut,
        totalCostUsd: this.#costKnown ? this.#costUsd : null,
        contextTokens: guard.tokens,
        contextLimit: this.contextLimit(),
        contextRatio: guard.ratio,
        warning: guard.warning,
        trimmed: guard.trimmed,
      };
    } finally {
      this.#busy = false;
    }
  }

  contextLimit(): number {
    return this.#registry.require(this.#modelRef).context;
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      startedAt: this.startedAt,
      model: this.modelName(),
      messages: this.messages.slice(),
      turns: this.#turns,
      tokensIn: this.#tokensIn,
      tokensOut: this.#tokensOut,
      costUsd: this.#costKnown ? this.#costUsd : null,
    };
  }

  /** Encerra a sessão e audita o run.completed uma única vez. */
  close(): void {
    if (this.#closed) return;
    if (this.#busy) throw new Error("turno em andamento");
    this.#closed = true;    this.#append("run.completed", {
      session: true,
      steps: this.#steps,
      turns: this.#turns,
      tokensIn: this.#tokensIn,
      tokensOut: this.#tokensOut,
      costUsd: this.#costKnown ? this.#costUsd : null,
    });
  }
}
