/**
 * Ciclo de vida do handoff (F-24, ADR-0006): varredura de pendências do run
 * no ledger do cwd corrente e ack do receptor — ler o artefato, validar o
 * schema e gravar `handoff.received` com `receiver_agent`.
 */
import type { Ledger } from "../ledger";
import { redactSecrets } from "../sanitize-external";
import { validateHandoffArtifact, HandoffError, type HandoffArtifactV1 } from "./types";

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
export function ackHandoff(deps: { ledger: Ledger; run: string }, handoffId: string, receiverAgent: string): HandoffArtifactV1 {
  const created = deps.ledger
    .readHandoffs()
    .find((e) => e.kind === "handoff.created" && e.handoff_id === handoffId);
  if (created === undefined) {
    throw new HandoffError("handoff_mismatch", `handoff ${handoffId} não encontrado no ledger`);
  }
  const artifact = validateHandoffArtifact(created.artifact);
  deps.ledger.recordHandoff("handoff.received", deps.run, artifact, { agent: receiverAgent, receiverAgent });
  return artifact;
}
