/**
 * Limite de saída por tool (S-16, CMP-10, ADR-0015): cap em tokens, artefato
 * com head+tail e referência de origem, e sanitização antes do contexto.
 * Stub RED.
 */

/** Config `outputLimit` (D-CFG1): teto absoluto e fração da janela. */
export interface OutputLimitConfig {
  maxTokens: number;
  shareOfWindow: number;
}

export const DEFAULT_OUTPUT_LIMIT: OutputLimitConfig = { maxTokens: 8000, shareOfWindow: 0.05 };

/** Cap efetivo em tokens: min(maxTokens, floor(shareOfWindow * janela)). */
export function effectiveOutputCap(_config: OutputLimitConfig | undefined, _contextWindow: number | undefined): number {
  throw new Error("não implementado");
}

export interface OutputLimitOptions {
  /** Teto em tokens estimados. */
  capTokens: number;
  /** Id da chamada da tool, usado no cabeçalho e no artefato. */
  toolCallId: string;
  /** Diretório do artefato (ex.: `<cwd>/.astro/outputs/<run>`). */
  artifactDir: string;
  /** Caminho exibido no contexto; default o próprio `artifactPath`. */
  displayPath?: (artifactPath: string) => string;
  /** Grava o artefato; default grava em disco. Injetável nos testes. */
  writeArtifact?: (path: string, content: string) => void;
}

export interface LimitedOutput {
  output: string;
  truncated: boolean;
  artifactPath?: string;
  unrecoverable?: boolean;
}

/** Sanitiza e, se passar do cap, grava o excedente e devolve head+tail+origem. */
export function limitToolOutput(_output: string, _opts: OutputLimitOptions): LimitedOutput {
  throw new Error("não implementado");
}
