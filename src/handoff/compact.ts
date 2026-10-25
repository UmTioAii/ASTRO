/**
 * Compactação estruturada do handoff (F-25, ADR-0006): o artefato carrega o
 * nível compacto e `source_refs` apontam ao intervalo do ledger de onde ele
 * veio. Perda é auditável (`compaction`), nunca silenciosa.
 *
 * Ordem de truncamento: primeiro `open_questions`, depois `decisions`;
 * NUNCA `task`/`objective`/`next_steps`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveWithin } from "../tools/paths";
import { HandoffError, type HandoffArtifactRef, type HandoffCompaction, type HandoffDraft } from "./types";

/** Teto padrão do nível compacto, em tokens estimados (~4 chars/token, F-09). */
export const DEFAULT_COMPACT_MAX_TOKENS = 512;

export interface CompactResult {
  draft: HandoffDraft;
  compaction: HandoffCompaction;
  truncated: boolean;
  originalTokens: number;
  returnedTokens: number;
}

/** Estimativa conservadora consistente com F-09 (~4 chars por token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compacta o draft até caber no teto, dropando campos na ordem fixa
 * (`open_questions`, depois `decisions`). `task`, `objective`, `constraints`
 * e `next_steps` nunca são dropados; se ainda exceder o teto, o conteúdo
 * permanece e a perda registrada é zero — o teto é guia, não corte desses.
 */
export function compactDraft(draft: HandoffDraft, maxTokens: number = DEFAULT_COMPACT_MAX_TOKENS): CompactResult {
  const originalTokens = estimateTokens(JSON.stringify(draft));
  const droppedFields: string[] = [];
  const kept: HandoffDraft = { ...draft };
  if (estimateTokens(JSON.stringify(kept)) > maxTokens && kept.open_questions !== undefined && kept.open_questions.length > 0) {
    droppedFields.push("open_questions");
    delete kept.open_questions;
  }
  if (estimateTokens(JSON.stringify(kept)) > maxTokens && kept.decisions.length > 0) {
    droppedFields.push("decisions");
    kept.decisions = [];
  }
  const returnedTokens = estimateTokens(JSON.stringify(kept));
  return {
    draft: kept,
    compaction: { strategy: droppedFields.length === 0 ? "none" : "truncate", droppedFields },
    truncated: droppedFields.length > 0,
    originalTokens,
    returnedTokens,
  };
}

/** Digest dos artefatos declarados pelo emissor; lidos dentro do cwd (I-11). */
export function digestArtifacts(cwd: string, paths: readonly string[]): HandoffArtifactRef[] {
  return paths.map((path) => {
    let resolved: string;
    try {
      resolved = resolveWithin(cwd, path);
    } catch (error) {
      // Emissor e receptor usam a mesma taxonomia (D-18): fora do cwd é mismatch
      const detail = error instanceof Error ? error.message : String(error);
      throw new HandoffError("handoff_artifact_mismatch", detail);
    }
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch {
      throw new HandoffError("handoff_artifact_mismatch", `artefato declarado não encontrado: ${path}`);
    }
    return { path, digest: createHash("sha256").update(content).digest("hex") };
  });
}

/**
 * Recepção: cada artefato citado existe dentro do cwd (I-11) e o digest
 * recalculado bate. Divergência é `handoff_artifact_mismatch`, não retentável.
 */
export function validateArtifacts(cwd: string, refs: readonly HandoffArtifactRef[]): void {
  for (const ref of refs) {
    let content: string;
    try {
      content = readFileSync(resolveWithin(cwd, ref.path), "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HandoffError("handoff_artifact_mismatch", `artefato "${ref.path}" indisponível no cwd: ${detail}`);
    }
    if (createHash("sha256").update(content).digest("hex") !== ref.digest) {
      throw new HandoffError("handoff_artifact_mismatch", `digest divergente do artefato "${ref.path}"`);
    }
  }
}
