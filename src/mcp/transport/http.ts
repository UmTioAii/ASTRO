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
  readonly #closeController = new AbortController();
  #session: string | undefined;
  #dead = false; // sessão expirada (404 com sessão enviada): o registry reconecta com nova sessão
  #nextId = 1;
  #closed = false;

  constructor(opts: { url: string; headers?: Record<string, string>; timeoutMs: number }) {
    this.#url = opts.url;
    this.#headers = opts.headers ?? {};
    this.#timeoutMs = opts.timeoutMs;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new MCPError("transport MCP fechado");
    const id = this.#nextId++;
    // Um controller por requisição: timeout só aborta a própria; close aborta todas.
    const requestAbort = new AbortController();
    const onClose = () => requestAbort.abort();
    this.#closeController.signal.addEventListener("abort", onClose);
    const timer = setTimeout(() => requestAbort.abort(), this.#timeoutMs);
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: this.#protocolHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: requestAbort.signal,
      });
      const session = response.headers.get("mcp-session-id");
      if (session !== null) this.#session = session;
      if (!response.ok) {
        if (response.status === 404 && this.#session !== undefined) this.#dead = true; // sessão expirada (spec streamable HTTP)
        throw new MCPError(`HTTP ${response.status} no MCP ${method}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) return await this.#readEventStream(response, id, method);
      const message = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (message.error !== undefined) throw new MCPError(message.error.message || "erro do servidor MCP");
      return message.result;
    } catch (error) {
      if (error instanceof MCPError) throw error;
      if (this.#closed) throw new MCPError("transport MCP fechado");
      if (requestAbort.signal.aborted) throw new MCPError(`timeout de ${this.#timeoutMs}ms no MCP ${method}`);
      throw new MCPError(`falha ao conectar no MCP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      this.#closeController.signal.removeEventListener("abort", onClose);
    }
  }

  /** Lê eventos `data:` do stream até a resposta com o id da requisição; evento não-JSON é ignorado. */
  async #readEventStream(response: Response, id: number, method: string): Promise<unknown> {
    let buffer = "";
    const decoder = new TextDecoder(); // um por stream: preserva UTF-8 partido entre chunks
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (data.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive textual ou lixo entre eventos não derruba a requisição
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue; // null/array/número: ignora
        const message = parsed as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id !== id) continue;
        if (message.error !== undefined) throw new MCPError(message.error.message || "erro do servidor MCP");
        return message.result;
      }
    }
    throw new MCPError(`stream do MCP ${method} encerrou sem resposta`);
  }

  #protocolHeaders(): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.#headers, ...(this.#session === undefined ? {} : { "mcp-session-id": this.#session }) };
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.#closed) return;
    // Notificação JSON-RPC não tem id e não aguarda resposta (melhor-esforço).
    void fetch(this.#url, { method: "POST", headers: this.#protocolHeaders(), body: JSON.stringify({ jsonrpc: "2.0", method, params }), signal: this.#closeController.signal }).catch(() => {});
  }

  /** True depois de close() ou de sessão expirada; timeout de requisição não mata (controller por requisição). */
  get closed(): boolean {
    return this.#closed || this.#dead;
  }

  close(): void {
    this.#closed = true;
    this.#closeController.abort();
  }
}
