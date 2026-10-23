/** Metadados obrigatórios de uma tool (I-12). */
export interface ToolManifest {
  name: string;
  description: string;
  parameters: object;
  risk: "low" | "medium" | "high";
  permission: string;
  timeoutMs: number;
  retryable: boolean;
}

/** Contexto de execução de uma tool. */
export interface ToolContext {
  cwd: string;
  run: string;
  agent: string;
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
