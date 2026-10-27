/** Tipos do cliente MCP (C2, #56); protocolo JSON-RPC 2.0 via fetch/Bun.spawn puro (D-02). */

/** Tool descoberta por `tools/list`. */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Resultado de `tools/call` (conteúdo sanitizado antes de qualquer log, I-03). */
export interface MCPToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Resposta do handshake `initialize`. */
export interface MCPServerInfo {
  name: string;
  version?: string;
}

export class MCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPError";
  }
}
