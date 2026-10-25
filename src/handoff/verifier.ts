/**
 * Verifier de identidade do handoff na recepção (F-26, I-18): garante via
 * única — o artefato recebido corresponde ao handoff que o runtime espera.
 *
 * Compara `run|from|to|taskHash` primariamente; usa o `source_step` do
 * artefato (F-23) com janela de tolerância de ±1 como desempate, sem
 * re-derivar step do ledger. Divergência → `handoff_mismatch`, não
 * retentável (D-18).
 */
import { HandoffError, taskHash, type HandoffArtifactV1 } from "./types";

/** Identidade esperada pelo runtime no momento da recepção. */
export interface HandoffIdentity {
  run: string;
  from: string;
  to: string;
  taskHash: string;
  source_step: number;
}

/** Verifica a identidade do artefato; lança `handoff_mismatch` na divergência. */
export function verifyHandoffIdentity(expected: HandoffIdentity, artifact: HandoffArtifactV1): void {
  const mismatch = (field: string): never => {
    throw new HandoffError("handoff_mismatch", `divergência de identidade no handoff: campo ${field}`);
  };
  if (artifact.run !== expected.run) mismatch("run");
  if (artifact.from !== expected.from) mismatch("from");
  if (artifact.to !== expected.to) mismatch("to");
  if (taskHash(artifact.task, artifact.objective) !== expected.taskHash) mismatch("taskHash");
  if (Math.abs(artifact.source_step - expected.source_step) > 1) mismatch("source_step");
}
