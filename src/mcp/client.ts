import type { MCPServerConfig } from "../config";
import { MCPError, type MCPServerInfo, type MCPToolDescriptor, type MCPToolResult } from "./types";
import { StdioTransport } from "./transport/stdio";

/**
 * Cliente MCP (C2a, #56): ciclo de vida connect/disconnect por servidor,
 * handshake `initialize`, descoberta `tools/list` e chamada `tools/call`
 * com o timeout da config. Transport stdio; http/sse entram na C2b.
 */
export class MCPClient {
  readonly serverInfo: MCPServerInfo;
  readonly #transport: { request: StdioTransport["request"]; close: () => void };

  private constructor(serverInfo: MCPServerInfo, transport: { request: StdioTransport["request"]; close: () => void }) {
    this.serverInfo = serverInfo;
    this.#transport = transport;
  }

  static async connect(server: MCPServerConfig): Promise<MCPClient> {
    if (server.transport !== "stdio") {
      throw new MCPError(`transport "${server.transport}" ainda não suportado (C2b)`);
    }
    const transport = StdioTransport.connect({
      command: server.command!,
      args: server.args ?? [],
      ...(server.env === undefined ? {} : { env: server.env }),
      timeoutMs: server.timeoutMs,
    });
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
