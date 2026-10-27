import type { MCPServerConfig } from "../config";
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
  reserved?: Iterable<string>;
  warn?: (message: string) => void;
}

function render(result: MCPToolResult): string {
  const text = result.content.filter((part) => typeof part.text === "string").map((part) => part.text!);
  return text.length > 0 ? text.join("\n") : JSON.stringify(result.content);
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
  const taken = new Set(opts.reserved ?? []);
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
        description: tool.description ?? `tool MCP ${server}/${tool.name}`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        risk: "high", // servidor MCP é código arbitrário (modelo de confiança)
        permission: `mcp:${server}`,
        // O transporte já aplica o timeout da config; o executor só não pode preemptá-lo.
        timeoutMs: (config?.timeoutMs ?? 30_000) + 1_000,
        retryable: true, // o registry reenvia uma vez após morte de transporte (at-least-once)
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
          auditCall(opts.audit, ctx, server, tool.name, started, "ok");
          return { output: render(result), ...(result.isError === true ? { isError: true } : {}) };
        } catch (error) {
          auditCall(opts.audit, ctx, server, tool.name, started, "error");
          throw error;
        }
      },
    });
  }

  return tools;
}
