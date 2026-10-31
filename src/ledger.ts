import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { PriceConfig } from "./config";
import { DEFAULT_LOCK_TIMEOUT_MS, FileLockError, processAlive, withFileLock } from "./file-lock";
import type { FallbackRecord } from "./provider/types";
import { handoffId, sanitizeHandoffArtifact, type HandoffArtifactV1 } from "./handoff/types";
import { appendDurable, jsonlLines, parseJsonl } from "./jsonl";
import { redactSecrets } from "./sanitize-external";

export { processAlive };

/** Versão do formato do ledger (ADR-0002): inteiro monotônico desde 1. */
export const LEDGER_SCHEMA_VERSION = 3;

/** Timeout do lock de arquivo (F-26/A4); depois falha fechado. */
const LEDGER_LOCK_TIMEOUT_MS = DEFAULT_LOCK_TIMEOUT_MS;

/** Lock de arquivo não pôde ser adquirido e a operação exige exclusividade (A4). */
export class LedgerLockError extends Error {
  readonly code = "ledger_lock_timeout";
  constructor(message: string) {
    super(message);
    this.name = "LedgerLockError";
  }
}

export interface LedgerEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  agent: string;
  provider: string;
  model: string;
  credentialRef?: string;
  quotaDomain: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Hash SHA-256 por tool call do step (F-02/I-03); array vazio sem calls. */
  callHashes?: string[];
  /** Profile da model pool do agent (F-29, ADR-0007); ausente sem profile. */
  profile?: string;
  /** Trocas de profile até o atendimento (F-31); ausente sem fallback. */
  fallbacks?: FallbackRecord[];
  /** Discriminador do JSONL; entradas antigas (pré-v1) não têm. */
  kind?: "usage";
  /** Ordem monotônica no arquivo (F-25, ADR-0006); entradas antigas não têm. */
  seq?: number;
  /** Nível de esforço (E1): 0=low .. 4=ultra. Ausente em entradas legadas. */
  lvl?: number;
  /** Esforço mapeado do lvl (E1). Ausente em entradas legadas. */
  effort?: string;
  /** Modo de thinking (E2). Ausente em entradas legadas. */
  thinking?: string;
  /** Parâmetros proibidos removidos antes do envio (E8). Ausente em entradas legadas. */
  "param.stripped"?: Array<{ name: string; reason: string } | string>;
}

/** Estado de execução de um run gravado no ledger (F-02). */
export type RunState = "interrupted" | "completed";

export interface LedgerStateEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  kind: "run_state";
  state: RunState;
  agent?: string;
  reason?: string;
  /** Ordem monotônica no arquivo (F-25). */
  seq?: number;
}

/** Evento de ciclo de vida de agent (S-05, PS-5, A4, M3). */
export type AgentEventKind = "created" | "destroyed" | "identity";

/** Entrada de lifecycle de agent no ledger (S-05). */
export interface LedgerAgentEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  kind: "agent";
  event: AgentEventKind;
  agent_id: string;
  parent_agent_id?: string;
  session_id: string;
  need?: string;
  model?: string;
  provider?: string;
  /** Nome da variável de credencial; nunca o valor (I-03). */
  credentialRef?: string;
  profile?: string;
  reason?: string;
  /** PID dono do lock (A4); ausente em ledger legado. */
  pid?: number;
  /** Snapshot de candidatos que originou a escolha (S-09/I-06). */
  snapshot_id?: string;
  seq: number;
}

/** Evento de budget no ledger (S-05, B9, B10, B4). */
export type BudgetEventKind = "reserved" | "released" | "exceeded" | "ceiling_hit" | "non_interactive";

/** Entrada de budget no ledger (S-05). */
export interface LedgerBudgetEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  agent: string;
  kind: "budget";
  event: BudgetEventKind;
  reserved?: number;
  released?: number;
  actual_cost?: number;
  detail?: string;
  exceeded_choice?: "continue_same" | "lower_effort" | "stop";
  ceiling_hit?: boolean;
  budget_exceeded_non_interactive?: boolean;
  seq: number;
}

/** Evento de compactação no ledger (S-05, CMP-6). */
export interface LedgerCompactionEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  agent: string;
  kind: "compaction";
  failure_count: number;
  manual: boolean;
  seq: number;
}

export type LedgerAnyEntry =
  | LedgerEntry
  | LedgerStateEntry
  | LedgerHandoffEntry
  | LedgerAgentEntry
  | LedgerBudgetEntry
  | LedgerCompactionEntry;

/** Tipos de evento de handoff durável (ADR-0006). */
export type HandoffEventKind = "handoff.created" | "handoff.received" | "handoff.failed" | "handoff.ack_timeout";

/** Evento de handoff no ledger: artefato íntegro e id determinístico. */
export interface LedgerHandoffEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  kind: HandoffEventKind;
  handoff_id: string;
  artifact: HandoffArtifactV1;
  agent?: string;
  /** Em `handoff.received`: quem recebeu e quando (F-24). */
  receiver_agent?: string;
  received_at?: string;
  /** Em `handoff.failed`/`handoff.ack_timeout`: razão redigida. */
  reason?: string;
  /** Ordem monotônica no arquivo (F-25). */
  seq?: number;
}

/**
 * Hash determinístico por tool call: SHA-256 de nome + arguments (F-02).
 * Identifica a operação sem persistir o conteúdo (I-03); `id` do provider
 * não entra no hash porque pode variar entre tentativas (F-03 usará isso).
 */
export function hashToolCalls(
  calls: readonly { name: string; arguments: string }[],
): string[] {
  return calls.map((c) =>
    createHash("sha256").update(JSON.stringify({ name: c.name, arguments: c.arguments })).digest("hex"),
  );
}

/** Custo em USD para os tokens informados, ou null quando não há preço curado. */
export function estimateCost(
  tokensIn: number,
  tokensOut: number,
  price?: PriceConfig,
): number | null {
  if (price === undefined) return null;
  return (tokensIn / 1_000_000) * price.inputPerM + (tokensOut / 1_000_000) * price.outputPerM;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Ledger de uso append-only em JSONL, com custo estimado por entrada. */
export class Ledger {
  readonly path: string;
  private readonly warn: (msg: string) => void;
  /** Callback opcional para observabilidade (F6-1: metrics). */
  /** Callback opcional para observabilidade (F6-1: metrics) — apenas entradas de uso. */
  private readonly onRecord?: (entry: LedgerEntry) => void;
  /** Próximo `seq` monotônico (F-25); calculado do arquivo na primeira escrita. */
  private nextSeq: number | undefined;
  /** Aviso de cauda parcial já emitido nesta instância. */
  private warnedPartialTail = false;
  /** Profundidade do lock desta instância (reentrância do append na seção crítica). */
  private lockDepth = 0;

  constructor(path: string, opts?: { warn?: (msg: string) => void; onRecord?: (entry: LedgerEntry) => void }) {
    this.path = path;
    this.warn = opts?.warn ?? ((msg) => console.warn(msg));
    this.onRecord = opts?.onRecord;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Identificador estável do arquivo de ledger (F-25): sha256 do caminho absoluto. */
  id(): string {
    return createHash("sha256").update(resolve(this.path)).digest("hex");
  }

  /**
   * Aloca `seq` e anexa sob lock de arquivo (I-04): outro processo no mesmo cwd
   * não repete `seq`. O maior `seq` é lido dentro do lock; o cache local é só
   * piso monotônico. As entradas nascem com `seq: 0`, substituído aqui.
   */
  private appendWithSeq<T extends { seq?: number }>(entry: T): T {
    return this.withFileLock(() => {
      let max = 0;
      for (const line of this.readLines()) {
        try {
          const e = JSON.parse(line) as { seq?: unknown };
          if (typeof e.seq === "number" && e.seq > max) max = e.seq;
        } catch { /* cauda parcial ou linha legada sem seq */ }
      }
      const seq = Math.max(this.nextSeq ?? 0, max + 1);
      this.nextSeq = seq + 1;
      entry.seq = seq;
      appendDurable(this.path, `${JSON.stringify(entry)}\n`);
      return entry;
    }, { failClosed: true });
  }

  record(e: Omit<LedgerEntry, "ts" | "costUsd" | "schemaVersion" | "kind">, price?: PriceConfig): LedgerEntry {
    const costUsd = estimateCost(e.tokensIn, e.tokensOut, price);
    if (e.lvl !== undefined && (!Number.isInteger(e.lvl) || e.lvl < 0 || e.lvl > 4)) {
      throw new Error(`nível de esforço inválido no ledger: ${String(e.lvl)} (esperado inteiro 0..4)`);
    }
    if (costUsd === null) {
      this.warn(
        `sem preço curado para o modelo "${e.provider}/${e.model}"; custo não calculado`,
      );
    }
    const stripped = e["param.stripped"] === undefined
      ? undefined
      : e["param.stripped"].map((s) => typeof s === "string"
        ? redactSecrets(s)
        : { name: redactSecrets(s.name), reason: redactSecrets(s.reason) });
    const effort = e.effort === undefined ? undefined : redactSecrets(e.effort);
    const thinking = e.thinking === undefined ? undefined : redactSecrets(e.thinking);
    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      kind: "usage",
      ts: new Date().toISOString(),
      ...e,
      run: redactSecrets(e.run), agent: redactSecrets(e.agent),
      ...(e.profile === undefined ? {} : { profile: redactSecrets(e.profile) }),
      ...(effort === undefined ? {} : { effort }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(stripped === undefined ? {} : { "param.stripped": stripped }),
      costUsd,
      seq: 0,
    };
    this.appendWithSeq(entry);
    if (this.onRecord !== undefined) this.onRecord(entry);
    return entry;
  }

  /** Grava o estado de execução de um run (F-02): `interrupted` ou `completed`. */
  recordState(
    run: string,
    state: RunState,
    opts?: { agent?: string; reason?: string },
  ): LedgerStateEntry {
    const entry: LedgerStateEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(run),
      kind: "run_state",
      state,
      ...(opts?.agent === undefined ? {} : { agent: redactSecrets(opts.agent) }),
      ...(opts?.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    return entry;
  }

  /** Entradas de uso (inclui legado sem kind); ignora estado e handoff. */
  readAll(): LedgerEntry[] {
    return this.readAllEntries().filter(
      (e): e is LedgerEntry => e.kind === undefined || e.kind === "usage",
    );
  }

  /** Todas as entradas do JSONL: uso, estado, handoff e legado, na ordem em que foram gravadas. */
  readAllEntries(): LedgerAnyEntry[] {
    const parsed = parseJsonl<LedgerAnyEntry>(this.readText(), `ledger em "${this.path}"`);
    if (parsed.droppedTail && !this.warnedPartialTail) {
      this.warnedPartialTail = true;
      this.warn(`ledger em "${this.path}": última linha parcial descartada`);
    }
    return parsed.entries;
  }

  /** Entradas com `seq` no intervalo [start, end], na ordem gravada (F-25). */
  readSeqRange(start: number, end: number): LedgerAnyEntry[] {
    return this.readAllEntries().filter((e) => typeof e.seq === "number" && e.seq >= start && e.seq <= end);
  }

  /** Primeiro e último `seq` das entradas de um run (F-25); undefined sem entradas. */
  seqBoundsOfRun(run: string): { start: number; end: number } | undefined {
    const target = redactSecrets(run);
    let start: number | undefined;
    let end: number | undefined;
    for (const e of this.readAllEntries()) {
      if (e.run !== target || typeof e.seq !== "number") continue;
      if (start === undefined || e.seq < start) start = e.seq;
      if (end === undefined || e.seq > end) end = e.seq;
    }
    return start === undefined || end === undefined ? undefined : { start, end };
  }

  /** Entradas de estado de execução, na ordem em que foram gravadas. */
  readStates(): LedgerStateEntry[] {
    return this.readAllEntries().filter((e): e is LedgerStateEntry => e.kind === "run_state");
  }

  /** Último estado de execução do run (undefined quando não há). */
  lastState(run?: string): LedgerStateEntry | undefined {
    const target = run === undefined ? undefined : redactSecrets(run);
    return this.readStates().filter((e) => target === undefined || e.run === target).at(-1);
  }

  /**
   * Grava um evento de handoff (ADR-0006). O artefato é sanitizado antes de ir
   * ao disco (I-03); `handoff_id` é recalculado do artefato já sanitizado.
   *
   * CAS de via única (F-26, I-18): `handoff.created`/`handoff.received`
   * existentes com o mesmo `handoff_id` são devolvidos sem duplicar. O CAS
   * depende do append atômico do ledger; o lock de arquivo abaixo serializa a
   * checagem+append entre processos — se o lock estiver quebrado/ocupado além
   * do timeout, segue em melhor esforço (mitigação documentada no ADR-0006).
   */
  recordHandoff(
    kind: HandoffEventKind,
    run: string,
    artifact: HandoffArtifactV1,
    opts?: { agent?: string; receiverAgent?: string; reason?: string },
  ): LedgerHandoffEntry {
    const safe = sanitizeHandoffArtifact(artifact);
    const id = handoffId(safe);
    if (kind === "handoff.created" || kind === "handoff.received") {
      // CAS de handoff preserva o melhor esforço documentado no ADR-0006.
      return this.withFileLock(() => {
        const existing = this.readHandoffs().find((e) => e.kind === kind && e.handoff_id === id);
        if (existing !== undefined) return existing;
        return this.appendHandoff(kind, run, safe, id, opts);
      }, { failClosed: false });
    }
    return this.appendHandoff(kind, run, safe, id, opts);
  }

  /**
   * Serializa uma seção crítica com lock de arquivo (F-26, A4). Erros de
   * `critical` propagam na hora; a disputa espera até o timeout. Sem lock vira
   * erro; melhor esforço só com `failClosed: false` explícito. Reentrante na
   * mesma instância: o append dentro de uma seção crítica já exclusiva não
   * tenta pegar o lock de novo.
   */
  withFileLock<T>(critical: () => T, opts: { failClosed?: boolean; timeoutMs?: number } = {}): T {
    if (this.lockDepth > 0) return critical();
    this.lockDepth++;
    try {
      return withFileLock(`${this.path}.lock`, critical, opts);
    } catch (error) {
      if (error instanceof FileLockError) throw new LedgerLockError(error.message);
      throw error;
    } finally {
      this.lockDepth--;
    }
  }

  private appendHandoff(
    kind: HandoffEventKind,
    run: string,
    safe: HandoffArtifactV1,
    id: string,
    opts?: { agent?: string; receiverAgent?: string; reason?: string },
  ): LedgerHandoffEntry {
    const ts = new Date().toISOString();
    const entry: LedgerHandoffEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts,
      run: redactSecrets(run),
      kind,
      handoff_id: id,
      artifact: safe,
      ...(opts?.agent === undefined ? {} : { agent: redactSecrets(opts.agent) }),
      ...(opts?.receiverAgent === undefined ? {} : { receiver_agent: redactSecrets(opts.receiverAgent), received_at: ts }),
      ...(opts?.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    return entry;
  }

  /** Eventos de handoff na ordem em que foram gravados. */
  readHandoffs(): LedgerHandoffEntry[] {
    return this.readAllEntries().filter((e): e is LedgerHandoffEntry => (e.kind ?? "").startsWith("handoff."));
  }

  total(): { tokensIn: number; tokensOut: number; costUsd: number } {
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    for (const entry of this.readAll()) {
      tokensIn += entry.tokensIn;
      tokensOut += entry.tokensOut;
      costUsd += entry.costUsd ?? 0;
    }
    return { tokensIn, tokensOut, costUsd };
  }

  /** Agregação por agent (F-30): tokens e custo por agent (+profile quando presente); provider/model do primeiro uso do bucket. */
  byAgent(): Record<string, { agent: string; profile?: string; provider: string; model: string; tokensIn: number; tokensOut: number; costUsd: number }> {
    const result: Record<string, { agent: string; profile?: string; provider: string; model: string; tokensIn: number; tokensOut: number; costUsd: number }> = Object.create(null);
    for (const entry of this.readAll()) {
      const key = entry.profile === undefined ? entry.agent : `${entry.agent}|${entry.profile}`;
      const agg = (result[key] ??= { agent: entry.agent, ...(entry.profile === undefined ? {} : { profile: entry.profile }), provider: entry.provider, model: entry.model, tokensIn: 0, tokensOut: 0, costUsd: 0 });
      agg.tokensIn += entry.tokensIn;
      agg.tokensOut += entry.tokensOut;
      agg.costUsd += entry.costUsd ?? 0;
    }
    return result;
  }

  /** Grava evento de criação de agent (S-05, PS-5, A4, M3). */
  recordAgentCreated(opts: {
    run: string;
    agent_id: string;
    parent_agent_id?: string;
    session_id: string;
    need?: string;
    model?: string;
    provider?: string;
    credentialRef?: string;
    profile?: string;
    reason?: string;
    /** PID dono do lock; default o processo atual (A4). */
    pid?: number;
    /** Snapshot de candidatos da escolha (I-06). */
    snapshot_id?: string;
  }): LedgerAgentEntry {
    const entry: LedgerAgentEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      kind: "agent",
      event: "created",
      agent_id: redactSecrets(opts.agent_id),
      ...(opts.parent_agent_id === undefined ? {} : { parent_agent_id: redactSecrets(opts.parent_agent_id) }),
      session_id: redactSecrets(opts.session_id),
      ...(opts.need === undefined ? {} : { need: redactSecrets(opts.need) }),
      ...(opts.model === undefined ? {} : { model: redactSecrets(opts.model) }),
      ...(opts.provider === undefined ? {} : { provider: redactSecrets(opts.provider) }),
      ...(opts.credentialRef === undefined ? {} : { credentialRef: redactSecrets(opts.credentialRef) }),
      ...(opts.profile === undefined ? {} : { profile: redactSecrets(opts.profile) }),
      ...(opts.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      ...(opts.snapshot_id === undefined ? {} : { snapshot_id: redactSecrets(opts.snapshot_id) }),
      pid: opts.pid ?? process.pid,
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Atualiza a identidade efetiva (provider/credencial) de um agente já ativo. */
  recordAgentIdentity(opts: {
    run: string;
    agent_id: string;
    session_id: string;
    model?: string;
    provider?: string;
    credentialRef?: string;
    profile?: string;
    reason?: string;
  }): LedgerAgentEntry {
    const entry: LedgerAgentEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      kind: "agent",
      event: "identity",
      agent_id: redactSecrets(opts.agent_id),
      session_id: redactSecrets(opts.session_id),
      ...(opts.model === undefined ? {} : { model: redactSecrets(opts.model) }),
      ...(opts.provider === undefined ? {} : { provider: redactSecrets(opts.provider) }),
      ...(opts.credentialRef === undefined ? {} : { credentialRef: redactSecrets(opts.credentialRef) }),
      ...(opts.profile === undefined ? {} : { profile: redactSecrets(opts.profile) }),
      ...(opts.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    return entry;
  }

  /** Grava evento de destruição de agent (S-05, PS-5, A4, M3). */
  recordAgentDestroyed(opts: {
    run: string;
    agent_id: string;
    session_id: string;
    reason?: string;
  }): LedgerAgentEntry {
    const entry: LedgerAgentEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      kind: "agent",
      event: "destroyed",
      agent_id: redactSecrets(opts.agent_id),
      session_id: redactSecrets(opts.session_id),
      ...(opts.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de reserva de budget (S-05, B9). */
  recordBudgetReserved(opts: {
    run: string;
    agent: string;
    reserved: number;
    detail?: string;
  }): LedgerBudgetEntry {
    const entry: LedgerBudgetEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "budget",
      event: "reserved",
      reserved: opts.reserved,
      ...(opts.detail === undefined ? {} : { detail: redactSecrets(opts.detail) }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de liberação de budget (S-05, B10). */
  recordBudgetReleased(opts: {
    run: string;
    agent: string;
    released: number;
    actual_cost?: number;
  }): LedgerBudgetEntry {
    const entry: LedgerBudgetEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "budget",
      event: "released",
      released: opts.released,
      ...(opts.actual_cost === undefined ? {} : { actual_cost: opts.actual_cost }),
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de budget excedido (S-05, B4). */
  recordBudgetExceeded(opts: {
    run: string;
    agent: string;
    exceeded_choice: "continue_same" | "lower_effort" | "stop";
  }): LedgerBudgetEntry {
    const entry: LedgerBudgetEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "budget",
      event: "exceeded",
      exceeded_choice: opts.exceeded_choice,
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de ceiling atingido (S-05, B10, I-17). */
  recordCeilingHit(opts: {
    run: string;
    agent: string;
    ceiling_hit: boolean;
  }): LedgerBudgetEntry {
    const entry: LedgerBudgetEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "budget",
      event: "ceiling_hit",
      ceiling_hit: opts.ceiling_hit,
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de budget excedido em modo não-interativo (S-05, B4). */
  recordBudgetExceededNonInteractive(opts: {
    run: string;
    agent: string;
    budget_exceeded_non_interactive: boolean;
  }): LedgerBudgetEntry {
    const entry: LedgerBudgetEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "budget",
      event: "non_interactive",
      budget_exceeded_non_interactive: opts.budget_exceeded_non_interactive,
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  /** Grava evento de compactação (S-05, CMP-6). */
  recordCompaction(opts: {
    run: string;
    agent: string;
    failure_count: number;
    manual: boolean;
  }): LedgerCompactionEntry {
    const entry: LedgerCompactionEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: redactSecrets(opts.run),
      agent: redactSecrets(opts.agent),
      kind: "compaction",
      failure_count: opts.failure_count,
      manual: opts.manual,
      seq: 0,
    };
    this.appendWithSeq(entry);
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  private readLines(): string[] {
    return jsonlLines(this.readText());
  }

  /** Conteúdo bruto do arquivo; ausente vira texto vazio. */
  private readText(): string {
    try {
      return readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }
}
