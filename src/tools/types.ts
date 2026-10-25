import type { CallJournal } from "../call-id";

/** Efeitos externos que a tool pode causar (F-10, I-12): vocabulário fechado. */
export type SideEffects = "none" | "filesystem" | "network" | "process";

/** Metadados obrigatórios de uma tool (I-12). */
export interface ToolManifest {
  name: string;
  description: string;
  parameters: object;
  risk: "low" | "medium" | "high";
  permission: string;
  timeoutMs: number;
  retryable: boolean;
  /** Repetir a mesma chamada deixa o sistema no mesmo estado (F-10). */
  idempotent: boolean;
  /** O que a tool pode mutar fora da conversa (F-10). */
  sideEffects: SideEffects;
}

/**
 * Contexto de execução de uma tool.
 *
 * `executor` é injetado pelo ToolExecutor ao chamar `tool.execute` e permite que
 * tools de composição (ex.: pipeline) executem sub-tools respeitando a MESMA
 * allowlist do agent (I-01), timeout por manifesto e auditoria. Tools comuns
 * ignoram o campo.
 */
export interface ToolContext {
  cwd: string;
  run: string;
  agent: string;
  /** Ambiente do run; `run_command` usa este mapa em vez de `process.env` quando presente. */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis que devem ser removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
  /** Executor da sessão; presente apenas quando chamado via ToolExecutor. */
  executor?: ToolExecutorLike;
  /** Step corrente da sessão; presente quando a sessão habilita dedup (F-03). */
  step?: number;
  /** Journal de resultados por call_id; presente quando a sessão habilita dedup (F-03). */
  journal?: CallJournal;
  /** Agents nomeados disponíveis; permite à tool handoff validar o destino (F-23). */
  knownAgents?: readonly string[];
}

/**
 * Superfície do executor que tools de composição podem usar.
 * Definida aqui (em vez de importar ToolExecutor) para evitar import cíclico.
 */
export interface ToolExecutorLike {
  run(ctx: ToolContext, call: { id: string; name: string; arguments: string }): Promise<ToolResult>;
  defs(): { name: string; description: string; parameters: object }[];
  /** Auditoria da sessão, para tools de composição logarem eventos próprios. */
  audit: AuditLike;
}

/** Superfície do Auditor para tools de composição. */
export interface AuditLike {
  append(event: { run: string; agent?: string; tipo: string; payload?: Record<string, unknown> }): unknown;
}

/** Resultado de uma tool; erros voltam ao modelo como resultado, não como exceção. */
export interface ToolResult {
  output: string;
  isError?: boolean;
}

/** Contrato de uma tool executável pelo agente. */
export interface Tool {
  manifest: ToolManifest;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Erro de validação ou de política de uma tool. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
