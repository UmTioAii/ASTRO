import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { PriceConfig } from "./config";
import type { FallbackRecord } from "./provider/types";
import { handoffId, sanitizeHandoffArtifact, type HandoffArtifactV1 } from "./handoff/types";
import { redactSecrets } from "./sanitize-external";

/** Versão do formato do ledger (ADR-0002): inteiro monotônico desde 1. */
export const LEDGER_SCHEMA_VERSION = 1;

/** Timeout do lock de arquivo do CAS de handoff (F-26); depois segue em melhor esforço. */
const LEDGER_LOCK_TIMEOUT_MS = 1_000;

export interface LedgerEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  agent: string;
  provider: string;
  model: string;
  credentialRef: string;
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
  "param.stripped"?: string[];
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
export type AgentEventKind = "created" | "destroyed";

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
  profile?: string;
  reason?: string;
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

  /** Consome o próximo `seq`; retoma a numeração de reaberturas do arquivo. */
  private takeSeq(): number {
    if (this.nextSeq === undefined) {
      let max = 0;
      for (const line of this.readLines()) {
        try {
          const e = JSON.parse(line) as { seq?: unknown };
          if (typeof e.seq === "number" && e.seq > max) max = e.seq;
        } catch { /* linha legada ilegível não tem seq */ }
      }
      this.nextSeq = max + 1;
    }
    return this.nextSeq++;
  }

  record(e: Omit<LedgerEntry, "ts" | "costUsd" | "schemaVersion" | "kind">, price?: PriceConfig): LedgerEntry {
    const costUsd = estimateCost(e.tokensIn, e.tokensOut, price);
    if (costUsd === null) {
      this.warn(
        `sem preço curado para o modelo "${e.provider}/${e.model}"; custo não calculado`,
      );
    }
    const stripped = e["param.stripped"] === undefined
      ? undefined
      : e["param.stripped"].map((s) => redactSecrets(s));
    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      kind: "usage",
      ts: new Date().toISOString(),
      ...e,
      run: redactSecrets(e.run), agent: redactSecrets(e.agent),
      ...(e.profile === undefined ? {} : { profile: redactSecrets(e.profile) }),
      ...(stripped === undefined ? {} : { "param.stripped": stripped }),
      costUsd,
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
    return this.readLines().map((line) => JSON.parse(line) as LedgerAnyEntry);
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
      return this.withLedgerLock(() => {
        const existing = this.readHandoffs().find((e) => e.kind === kind && e.handoff_id === id);
        if (existing !== undefined) return existing;
        return this.appendHandoff(kind, run, safe, id, opts);
      });
    }
    return this.appendHandoff(kind, run, safe, id, opts);
  }

  /** Serializa a seção crítica do CAS com um lock de arquivo (F-26). */
  private withLedgerLock<T>(critical: () => T): T {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS;
    for (;;) {
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, "wx"); // exclusivo: falha se outro processo segura o lock
        try {
          return critical();
        } finally {
          closeSync(fd);
          rmSync(lockPath, { force: true });
        }
      } catch {
        if (Date.now() >= deadline) return critical(); // lock quebrado: melhor esforço
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // espera síncrona de 5ms
      }
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
    profile?: string;
    reason?: string;
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
      ...(opts.profile === undefined ? {} : { profile: redactSecrets(opts.profile) }),
      ...(opts.reason === undefined ? {} : { reason: redactSecrets(opts.reason) }),
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    // onRecord só é chamado para entradas de uso (kind === "usage")
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
      seq: this.takeSeq(),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    // onRecord só é chamado para entradas de uso (kind === "usage")
    return entry;
  }

  private readLines(): string[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }
}
