import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { PriceConfig } from "./config";
import { handoffId, sanitizeHandoffArtifact, type HandoffArtifactV1 } from "./handoff/types";

/** Versão do formato do ledger (ADR-0002): inteiro monotônico desde 1. */
export const LEDGER_SCHEMA_VERSION = 1;

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
  /** Discriminador do JSONL; entradas antigas (pré-v1) não têm. */
  kind?: "usage";
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
}

export type LedgerAnyEntry = LedgerEntry | LedgerStateEntry | LedgerHandoffEntry;

/** Tipos de evento de handoff durável (ADR-0006). */
export type HandoffEventKind = "handoff.created" | "handoff.received";

/** Evento de handoff no ledger: artefato íntegro e id determinístico. */
export interface LedgerHandoffEntry {
  schemaVersion: number;
  ts: string;
  run: string;
  kind: HandoffEventKind;
  handoff_id: string;
  artifact: HandoffArtifactV1;
  agent?: string;
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
  private readonly path: string;
  private readonly warn: (msg: string) => void;
  /** Callback opcional para observabilidade (F6-1: metrics). */
  private readonly onRecord?: (entry: LedgerEntry) => void;

  constructor(path: string, opts?: { warn?: (msg: string) => void; onRecord?: (entry: LedgerEntry) => void }) {
    this.path = path;
    this.warn = opts?.warn ?? ((msg) => console.warn(msg));
    this.onRecord = opts?.onRecord;
    mkdirSync(dirname(path), { recursive: true });
  }

  record(e: Omit<LedgerEntry, "ts" | "costUsd" | "schemaVersion" | "kind">, price?: PriceConfig): LedgerEntry {
    const costUsd = estimateCost(e.tokensIn, e.tokensOut, price);
    if (costUsd === null) {
      this.warn(
        `sem preço curado para o modelo "${e.provider}/${e.model}"; custo não calculado`,
      );
    }
    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      kind: "usage",
      ts: new Date().toISOString(),
      ...e,
      costUsd,
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
      run,
      kind: "run_state",
      state,
      ...(opts?.agent === undefined ? {} : { agent: opts.agent }),
      ...(opts?.reason === undefined ? {} : { reason: opts.reason }),
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

  /** Entradas de estado de execução, na ordem em que foram gravadas. */
  readStates(): LedgerStateEntry[] {
    return this.readAllEntries().filter((e): e is LedgerStateEntry => e.kind === "run_state");
  }

  /** Último estado de execução do run (undefined quando não há). */
  lastState(run?: string): LedgerStateEntry | undefined {
    const states = this.readStates().filter((e) => run === undefined || e.run === run);
    return states.at(-1);
  }

  /**
   * Grava um evento de handoff (ADR-0006). O artefato é sanitizado antes de ir
   * ao disco (I-03); `handoff_id` é recalculado do artefato já sanitizado.
   */
  recordHandoff(
    kind: HandoffEventKind,
    run: string,
    artifact: HandoffArtifactV1,
    opts?: { agent?: string },
  ): LedgerHandoffEntry {
    const safe = sanitizeHandoffArtifact(artifact);
    const entry: LedgerHandoffEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run,
      kind,
      handoff_id: handoffId(safe),
      artifact: safe,
      ...(opts?.agent === undefined ? {} : { agent: opts.agent }),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /** Eventos de handoff na ordem em que foram gravados. */
  readHandoffs(): LedgerHandoffEntry[] {
    return this.readAllEntries().filter(
      (e): e is LedgerHandoffEntry => e.kind === "handoff.created" || e.kind === "handoff.received",
    );
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

  /** Agregação por agent: tokens e custo de cada agent no ledger. */
  byAgent(): Record<string, { tokensIn: number; tokensOut: number; costUsd: number }> {
    const result: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }> = Object.create(null);
    for (const entry of this.readAll()) {
      const agg = (result[entry.agent] ??= { tokensIn: 0, tokensOut: 0, costUsd: 0 });
      agg.tokensIn += entry.tokensIn;
      agg.tokensOut += entry.tokensOut;
      agg.costUsd += entry.costUsd ?? 0;
    }
    return result;
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
