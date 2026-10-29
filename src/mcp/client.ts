import type { MCPServerConfig } from "../config";
import { MCPError, type MCPServerInfo, type MCPToolDescriptor, type MCPToolResult } from "./types";
import { StdioTransport } from "./transport/stdio";
import { HttpTransport } from "./transport/http";
import { SseTransport } from "./transport/sse";
import { resolveMcpHeaders } from "./headers";

/** Contrato comum dos transports (C2b): request/notify/close; `closed` diz se o transporte morreu. */
export interface MCPTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Cliente MCP (C2, #56): ciclo de vida connect/disconnect por servidor,
 * handshake `initialize`, descoberta `tools/list` e chamada `tools/call`
 * com o timeout da config. Transports: stdio, http (streamable) e sse (legacy).
 */
export class MCPClient {
  readonly serverInfo: MCPServerInfo;
  readonly #transport: MCPTransport;

  private constructor(serverInfo: MCPServerInfo, transport: MCPTransport) {
    this.serverInfo = serverInfo;
    this.#transport = transport;
  }

  /** True quando o transporte morreu (processo encerrou, stream acabou, close). */
  get closed(): boolean {
    return this.#transport.closed;
  }
  static async connect(server: MCPServerConfig, env: NodeJS.ProcessEnv = process.env): Promise<MCPClient> {
    // Resolve antes de criar transporte/rede: variável ausente falha sem chamada.
    const headers = server.transport === "stdio" ? undefined : resolveMcpHeaders(server.headers, env);
    let transport: MCPTransport;
    if (server.transport === "stdio") {
      transport = StdioTransport.connect({ command: server.command!, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), timeoutMs: server.timeoutMs });
    } else if (server.transport === "http") {
      transport = new HttpTransport({ url: server.url!, ...(headers === undefined ? {} : { headers }), timeoutMs: server.timeoutMs });
    } else if (server.transport === "sse") {
      transport = await SseTransport.connect({ url: server.url!, ...(headers === undefined ? {} : { headers }), timeoutMs: server.timeoutMs });
    } else {
      throw new MCPError(`transport "${server.transport}" não suportado`);
    }
    let result: { serverInfo?: MCPServerInfo };
    try {
      result = (await transport.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "astro", version: "0.1" },
      })) as { serverInfo?: MCPServerInfo };
    } catch (error) {
      transport.close(); // handshake travado/erro: nada de processo órfão
      throw error;
    }
    if (result?.serverInfo === undefined || typeof result.serverInfo.name !== "string") {
      transport.close();
      throw new MCPError("handshake MCP sem serverInfo");
    }
    transport.notify("notifications/initialized", {});
    return new MCPClient(result.serverInfo, transport);
  }

  async listTools(): Promise<MCPToolDescriptor[]> {
    const result = (await this.#transport.request("tools/list", {})) as { tools?: MCPToolDescriptor[] };
    if (!Array.isArray(result?.tools)) throw new MCPError("resposta tools/list sem tools");
    return result.tools.filter((tool) => tool !== null && typeof tool.name === "string");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = (await this.#transport.request("tools/call", { name, arguments: args })) as MCPToolResult;
    if (!Array.isArray(result?.content)) throw new MCPError(`resposta de tools/call "${name}" sem content`);
    return result;
  }

  close(): void {
    this.#transport.close();
  }
}
