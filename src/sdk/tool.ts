/**
 * ASTRO Tool SDK (F7-3): superfície pública para construir tools — builtin,
 * plugin ou pacote npm. Contratos, validação de manifesto (I-12: nome, risco,
 * permissão, timeout, retryable) e harness de teste.
 *
 * Uso em plugin:
 *   import { defineTool } from "./src/sdk/tool";
 *   export function definePlugin() {
 *     return { name: "minhas-tools", tools: [myTool] };
 *   }
 */
import type { Tool, ToolContext, ToolManifest, ToolResult } from "../tools/types";
import { ToolError } from "../tools/types";

// Re-exports do contrato (superfície estável do SDK)
export type { Tool, ToolContext, ToolManifest, ToolResult };
export { ToolError };

const RISKS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
const SIDE_EFFECTS: ReadonlySet<string> = new Set(["none", "filesystem", "network", "process"]);
const TOOL_CLASSES: ReadonlySet<string> = new Set([
  "read_common", "read_critical", "edit", "delete", "shell", "identity_swap",
]);

/** Valida um manifesto de tool (I-12); lança ToolError com campo culpado. */
export function validateManifest(value: unknown): ToolManifest {
  if (typeof value !== "object" || value === null) {
    throw new ToolError("manifesto de tool deve ser um objeto");
  }
  const m = value as Record<string, unknown>;

  if (typeof m.name !== "string" || m.name.trim().length === 0) {
    throw new ToolError("manifesto.name deve ser uma string não vazia");
  }
  if (typeof m.description !== "string" || m.description.length === 0) {
    throw new ToolError("manifesto.description deve ser uma string não vazia");
  }
  if (typeof m.parameters !== "object" || m.parameters === null || Array.isArray(m.parameters)) {
    throw new ToolError("manifesto.parameters deve ser um objeto (JSON Schema)");
  }
  if (typeof m.risk !== "string" || !RISKS.has(m.risk)) {
    throw new ToolError(`manifesto.risk deve ser "low", "medium" ou "high"`);
  }
  if (typeof m.permission !== "string" || m.permission.trim().length === 0) {
    throw new ToolError("manifesto.permission deve ser uma string não vazia");
  }
  if (typeof m.class !== "string" || !TOOL_CLASSES.has(m.class)) {
    throw new ToolError(
      'manifesto.class deve ser "read_common", "read_critical", "edit", "delete", "shell" ou "identity_swap"',
    );
  }
  if (
    typeof m.timeoutMs !== "number" ||
    !Number.isInteger(m.timeoutMs) ||
    m.timeoutMs <= 0
  ) {
    throw new ToolError("manifesto.timeoutMs deve ser um inteiro positivo");
  }
  if (typeof m.retryable !== "boolean") {
    throw new ToolError("manifesto.retryable deve ser booleano");
  }
  if (typeof m.idempotent !== "boolean") {
    throw new ToolError("manifesto.idempotent deve ser booleano");
  }
  if (typeof m.sideEffects !== "string" || !SIDE_EFFECTS.has(m.sideEffects)) {
    throw new ToolError('manifesto.sideEffects deve ser "none", "filesystem", "network" ou "process"');
  }

  return {
    name: m.name,
    description: m.description,
    parameters: m.parameters,
    risk: m.risk as ToolManifest["risk"],
    permission: m.permission,
    class: m.class as ToolManifest["class"],
    timeoutMs: m.timeoutMs,
    retryable: m.retryable,
    idempotent: m.idempotent,
    sideEffects: m.sideEffects as ToolManifest["sideEffects"],
  };
}

/**
 * Define uma tool com validação de manifesto no momento da criação:
 * falha cedo (no load do plugin), não em runtime por chamada.
 */
export function defineTool(
  manifest: unknown,
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>,
): Tool {
  return { manifest: validateManifest(manifest), execute };
}

/** Harness de teste: tool com execute injetado e registro de chamadas. */
export function createMockTool(
  manifest: ToolManifest,
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>,
): Tool & { calls: Array<{ input: unknown; ctx: ToolContext }> } {
  const calls: Array<{ input: unknown; ctx: ToolContext }> = [];
  return {
    manifest,
    calls,
    async execute(input, ctx): Promise<ToolResult> {
      calls.push({ input, ctx });
      return execute(input, ctx);
    },
  };
}

/** Resultado de erro de conveniência (contrato: erro volta como resultado). */
export function toolFailure(message: string): ToolResult {
  return { output: message, isError: true };
}

/** Resultado de sucesso de conveniência. */
export function toolSuccess(output: string): ToolResult {
  return { output };
}