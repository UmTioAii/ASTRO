/**
 * Ciclo de vida do handoff (F-24, ADR-0006): varredura de pendências do run
 * no ledger do cwd corrente e ack do receptor — ler o artefato, validar o
 * schema e gravar `handoff.received` com `receiver_agent`.
 * F-25: recuperação por `source_refs` e saída do `astro handoff show`.
 */
import type { Ledger, LedgerAnyEntry } from "../ledger";
import { redactSecrets } from "../sanitize-external";
import { validateHandoffArtifact, HandoffError, type HandoffArtifactV1, type HandoffSourceRefs } from "./types";
import { validateArtifacts } from "./compact";

/** Estado de um handoff na varredura: created sem received é retomável. */
export type HandoffState = "pending" | "completed" | "failed";

export interface HandoffStatus {
  handoff_id: string;
  state: HandoffState;
  artifact: HandoffArtifactV1;
  /** Presente quando `state === "failed"`; razão redigida no ledger. */
  reason?: string;
}

/**
 * Varre os handoffs de um run no ledger informado (paths.ledger do cwd
 * corrente): `pending` (created sem received), `completed` (received) e
 * `failed` (received e depois handoff.failed — terminal, não reexecuta).
 * `handoff.ack_timeout` não muda o estado: o handoff volta a `pending`.
 */
export function scanHandoffs(ledger: Ledger, run?: string): HandoffStatus[] {
  const target = run === undefined ? undefined : redactSecrets(run);
  const byId = new Map<string, HandoffStatus>();
  for (const e of ledger.readHandoffs()) {
    if (target !== undefined && e.run !== target) continue;
    const status = byId.get(e.handoff_id) ?? { handoff_id: e.handoff_id, state: "pending", artifact: e.artifact };
    byId.set(e.handoff_id, status);
    if (e.kind === "handoff.received" && status.state !== "failed") status.state = "completed";
    if (e.kind === "handoff.failed") {
      status.state = "failed";
      if (e.reason !== undefined) status.reason = e.reason;
    }
  }
  return [...byId.values()];
}

/**
 * Receptor confirma o recebimento (F-24): lê o `HandoffArtifact` do ledger
 * pelo `handoff_id`, valida o schema e grava `handoff.received` com
 * `received_at` e `receiver_agent`. Artefato ausente ou inválido falha com
 * código estável; nada é gravado nesse caso.
 */
export function ackHandoff(deps: { ledger: Ledger; run: string; cwd?: string }, handoffId: string, receiverAgent: string): HandoffArtifactV1 {
  const created = deps.ledger
    .readHandoffs()
    .find((e) => e.kind === "handoff.created" && e.handoff_id === handoffId);
  if (created === undefined) {
    throw new HandoffError("handoff_mismatch", `handoff ${handoffId} não encontrado no ledger`);
  }
  const artifact = validateHandoffArtifact(created.artifact);
  // Recepção (F-25): artefatos citados existem dentro do cwd e o digest bate (I-11)
  if (deps.cwd !== undefined && artifact.artifacts !== undefined) {
    validateArtifacts(deps.cwd, artifact.artifacts);
  }
  deps.ledger.recordHandoff("handoff.received", deps.run, artifact, { agent: receiverAgent, receiverAgent });
  return artifact;
}

/**
 * Recupera o detalhe do intervalo de `source_refs` no ledger (F-25): o
 * receptor com `truncated: true` relê a origem. Ledger estranho → mismatch.
 */
export function readSourceRefs(ledger: Ledger, refs: HandoffSourceRefs): LedgerAnyEntry[] {
  if (refs.ledger_id !== ledger.id()) {
    throw new HandoffError("handoff_mismatch", `source_refs aponta para outro ledger: ${refs.ledger_id}`);
  }
  return ledger.readSeqRange(refs.seq_start, refs.seq_end);
}

/** Saída do `astro handoff show <handoff_id>` (F-25): artefato + compactação. */
export function formatHandoffShow(ledger: Ledger, handoffId: string): string {
  const events = ledger.readHandoffs().filter((e) => e.handoff_id === handoffId);
  if (events.length === 0) {
    throw new HandoffError("handoff_mismatch", `handoff ${handoffId} não encontrado no ledger`);
  }
  const latest = events.at(-1)!;
  const a = latest.artifact;
  const compaction = a.compaction ?? { strategy: "none" as const, droppedFields: [] };
  return [
    `handoff ${handoffId} [${latest.kind}]`,
    `  run: ${a.run} · de "${a.from}" para "${a.to}" · passo ${a.source_step}`,
    `  budget: ${a.budget_spent.tokens} tokens · US$ ${a.budget_spent.usd}`,
    `  compactação: ${compaction.strategy}${compaction.droppedFields.length > 0 ? ` (dropou: ${compaction.droppedFields.join(", ")})` : ""}${a.truncated === true ? ` · truncado (${a.originalTokens} → ${a.returnedTokens} tokens)` : ""}`,
    `  artefatos: ${a.artifacts === undefined || a.artifacts.length === 0 ? "nenhum" : a.artifacts.map((r) => `${r.path} (${r.digest.slice(0, 12)}…)`).join(", ")}`,
    `  artefato: ${JSON.stringify(a)}`,
  ].join("\n");
}
