import { MCPError } from "../types";

/**
 * Transport HTTP streamable do MCP (#56): cada requisição é um POST JSON-RPC;
 * a resposta pode ser JSON direto ou um stream SSE de um evento. O
 * `mcp-session-id` devolvido no initialize é mantido nas chamadas seguintes.
 */
export class HttpTransport {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #abort = new AbortController();
  #session: string | undefined;
  #nextId = 1;

  constructor(opts: { url: string; headers?: Record<string, string>; timeoutMs: number }) {
    this.#url = opts.url;
    this.#headers = opts.headers ?? {};
    this.#timeoutMs = opts.timeoutMs;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const timer = setTimeout(() => this.#abort.abort(), this.#timeoutMs);
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...this.#headers,
          ...(this.#session === undefined ? {} : { "mcp-session-id": this.#session }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: this.#abort.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session !== null) this.#session = session;
      if (!response.ok) throw new MCPError(`HTTP ${response.status} no MCP ${method}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) return await this.#readEventStream(response, id, method);
      const message = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (message.error !== undefined) throw new MCPError(message.error.message ?? "erro do servidor MCP");
      return message.result;
    } catch (error) {
      if (error instanceof MCPError) throw error;
      if (this.#abort.signal.aborted) throw new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`);
      throw new MCPError(`falha ao conectar no MCP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lê eventos `data:` do stream até a resposta com o id da requisição. */
  async #readEventStream(response: Response, id: number, method: string): Promise<unknown> {
    let buffer = "";
    for await (const chunk of response.body!) {
      buffer += new TextDecoder().decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (data.length === 0) continue;
        const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id !== id) continue;
        if (message.error !== undefined) throw new MCPError(message.error.message ?? "erro do servidor MCP");
        return message.result;
      }
    }
    throw new MCPError(`stream do MCP ${method} encerrou sem resposta`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    // Notificação JSON-RPC não tem id e não aguarda resposta (melhor-esforço).
    void fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers,
        ...(this.#session === undefined ? {} : { "mcp-session-id": this.#session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: this.#abort.signal,
    }).catch(() => {});
  }

  close(): void {
    this.#abort.abort();
  }
}
