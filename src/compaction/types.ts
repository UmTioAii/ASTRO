/**
 * Artefato de compactação de sessão (S-17, CMP-4): NÃO reusa
 * `HandoffArtifactV1`. Seções Active, Blocked, Next Move, Relevant Files
 * (máx. 15) e Important Context; campos compartilhados com handoff são copiados.
 * Stub RED.
 */
import type { ChatMessage } from "../provider/types";

export interface CompactionArtifactV1 {
  schemaVersion: 1;
  run: string;
  /** O que está em andamento (última mensagem de usuário). */
  active: string;
  /** Impedimentos/erros conhecidos. */
  blocked: string[];
  /** Próximo passo (último texto do assistente). */
  nextMove: string;
  /** Caminhos citados em tool calls, no máximo 15. */
  relevantFiles: string[];
  /** Resumo gerado pelo modelo (sem tools). */
  importantContext: string;
}

export const MAX_RELEVANT_FILES = 15;

export interface BuildArtifactInput {
  run: string;
  /** Histórico antigo que está sendo substituído (sem system). */
  older: readonly ChatMessage[];
  /** Parte recente preservada. */
  recent: readonly ChatMessage[];
  summary: string;
}

/** Monta o artefato a partir do histórico e do resumo. */
export function buildCompactionArtifact(_input: BuildArtifactInput): CompactionArtifactV1 {
  throw new Error("não implementado");
}

/** Renderiza o artefato como mensagem de sistema para o contexto compactado. */
export function renderCompactionArtifact(_artifact: CompactionArtifactV1): string {
  throw new Error("não implementado");
}
