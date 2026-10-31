import type { MCPServerConfig } from "../config";
import { sanitizeExternal } from "../sanitize-external";
import type { AuditLike, Tool, ToolContext } from "../tools/types";
import { mcpToolName, type MCPDiscoveredTool } from "./registry";
import type { MCPToolResult } from "./types";

/** Superfície mínima do registry usada pelo adaptador (facilita teste sem transporte). */
export interface McpToolSource {
  listTools(): MCPDiscoveredTool[];
  call(server: string, tool: string, args: Record<string, unknown>): Promise<MCPToolResult>;
}

export interface McpToolsOptions {
  registry: McpToolSource;
  servers: Record<string, MCPServerConfig>;
  audit: AuditLike;
  /** Nomes já ocupados (builtin/plugin): tool MCP em colisão é ignorada, nunca sobrescreve. */
  reserved: Iterable<string>;
  warn?: (message: string) => void;
}

function render(result: MCPToolResult): string {
  // `content` vem de servidor não confiável: parts nulas/não-objeto não podem derrubar a chamada.
  const parts = Array.isArray(result.content)
    ? result.content.filter((part) => typeof part === "object" && part !== null)
    : [];
  const text = parts.filter((part) => typeof part.text === "string").map((part) => part.text!);
  return text.length > 0 ? text.join("\n") : JSON.stringify(parts);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function schemaObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { type: "object", properties: {} };
}

function auditCall(
  audit: AuditLike,
  ctx: ToolContext,
  server: string,
  tool: string,
  started: number,
  status: "ok" | "error",
): void {
  // Só metadados: argumentos e resposta podem conter segredo (I-03).
  audit.append({
    run: ctx.run,
    agent: ctx.agent,
    tipo: "mcp.call",
    payload: { server, tool, durationMs: Date.now() - started, status },
  });
}

/**
 * Converte tools descobertas em tools do ToolExecutor (C2d, #56): namespace
 * `mcp__<server>__<tool>`, allowlist do agent (I-01) e audit `mcp.call` sem
 * argumentos/resposta (I-03).
 */
export function mcpTools(opts: McpToolsOptions): Tool[] {
  const warn = opts.warn ?? ((message: string) => console.warn(`mcp: ${message}`));
  const taken = new Set(opts.reserved);
  const tools: Tool[] = [];

  for (const { server, tool } of opts.registry.listTools()) {
    const name = mcpToolName(server, tool.name);
    if (taken.has(name)) {
      warn(`tool MCP "${name}" ignorada: nome já em uso`);
      continue;
    }
    taken.add(name);
    const config = opts.servers[server];

    tools.push({
      manifest: {
        name,
        description: nonEmptyString(tool.description) ?? `tool MCP ${server}/${tool.name}`,
        parameters: schemaObject(tool.inputSchema),
        risk: "high", // servidor MCP é código arbitrário (modelo de confiança)
        permission: `mcp:${server}`,
        // Pior caso do registry após morte de transporte: call + initialize + tools/list + retry call.
        timeoutMs: (config?.timeoutMs ?? 30_000) * 4 + 1_000,
        // Tool opaca pode ter efeito colateral: não é seguro reenviar por conta própria.
        retryable: false,
        idempotent: false,
        sideEffects: config?.transport === "stdio" ? "process" : "network",
      },
      async execute(input, ctx) {
        const started = Date.now();
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          return { output: `argumentos inválidos para a tool "${name}": esperado objeto`, isError: true };
        }
        try {
          const result = await opts.registry.call(server, tool.name, input as Record<string, unknown>);
          const failed = result.isError === true;
          // Saída de servidor MCP é conteúdo externo: redige segredo na origem (I-03). Teto e
          // artefato ficam no executor (CMP-10); truncar aqui perderia a cauda recuperável.
          const output = sanitizeExternal(render(result), { maxTokens: Number.POSITIVE_INFINITY }).content; // antes do audit: falha de render vira um único status error
          auditCall(opts.audit, ctx, server, tool.name, started, failed ? "error" : "ok");
          return { output, ...(failed ? { isError: true } : {}) };
        } catch (error) {
          auditCall(opts.audit, ctx, server, tool.name, started, "error");
          throw error;
        }
      },
    });
  }

  return tools;
}
