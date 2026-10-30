/**
 * Artefato de compactação de sessão (S-17, CMP-4): NÃO reusa
 * `HandoffArtifactV1`. Seções Active, Blocked, Next Move, Relevant Files
 * (máx. 15) e Important Context; campos compartilhados com handoff são copiados.
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
const SECTION_CLIP = 500;
const SUMMARY_CLIP = 4_000;

function clip(value: string, max = SECTION_CLIP): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Caminhos citados nos argumentos de tool calls (`{"path": "..."}`). */
function pathsIn(calls: readonly { arguments: string }[]): string[] {
  const paths: string[] = [];
  for (const call of calls) {
    try {
      const parsed = JSON.parse(call.arguments) as { path?: unknown };
      if (typeof parsed.path === "string" && parsed.path.length > 0) paths.push(parsed.path);
      continue;
    } catch {
      // argumentos ilegíveis: tenta o padrão textual
    }
    for (const match of call.arguments.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
      paths.push(match[1]!);
    }
  }
  return paths;
}

function isErrorOutput(content: string): boolean {
  const trimmed = content.trimStart();
  return /^erro\b/i.test(trimmed) || /"error"\s*:/.test(trimmed);
}

export interface BuildArtifactInput {
  run: string;
  /** Histórico antigo que está sendo substituído (sem system). */
  older: readonly ChatMessage[];
  /** Parte recente preservada. */
  recent: readonly ChatMessage[];
  summary: string;
}

/** Monta o artefato a partir do histórico e do resumo. */
export function buildCompactionArtifact(input: BuildArtifactInput): CompactionArtifactV1 {
  const all = [...input.older, ...input.recent];
  const active = [...all].reverse().find((message) => message.role === "user" && message.content.length > 0);
  const nextMove = [...all].reverse().find(
    (message) => message.role === "assistant" && message.content.trim().length > 0,
  );
  const blocked = all
    .filter((message) => message.role === "tool" && isErrorOutput(message.content))
    .map((message) => clip(message.content, 300));
  const files: string[] = [];
  for (const message of all) {
    for (const path of pathsIn(message.toolCalls ?? [])) {
      if (!files.includes(path)) files.push(path);
    }
  }

  return {
    schemaVersion: 1,
    run: input.run,
    active: clip(active?.content ?? ""),
    blocked,
    nextMove: clip(nextMove?.content ?? ""),
    relevantFiles: files.slice(0, MAX_RELEVANT_FILES),
    importantContext: clip(input.summary, SUMMARY_CLIP),
  };
}

/** Renderiza o artefato como mensagem de sistema para o contexto compactado. */
export function renderCompactionArtifact(artifact: CompactionArtifactV1): string {
  return [
    `[CompactionArtifactV1 run=${artifact.run}]`,
    `Active: ${artifact.active}`,
    `Blocked: ${artifact.blocked.length === 0 ? "—" : artifact.blocked.join(" | ")}`,
    `Next Move: ${artifact.nextMove}`,
    `Relevant Files: ${artifact.relevantFiles.length === 0 ? "—" : artifact.relevantFiles.join(", ")}`,
    `Important Context: ${artifact.importantContext}`,
  ].join("\n");
}
