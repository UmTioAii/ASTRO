/**
 * Completion cache (F6-4): respostas de provider cacheadas por chave
 * determinística (SHA-256 de {model, messages, tools}) em SQLite nativo do Bun.
 * Hit devolve a resposta com usage zerado — nenhum token novo é gasto e o
 * custo no ledger é naturalmente 0. Miss executa e armazena.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { CompletionRequest, CompletionResponse, Provider } from "./provider/types";

/** Chave determinística da request: modelo + mensagens + tools. */
export function cacheKey(req: CompletionRequest): string {
  const canonical = JSON.stringify({
    model: req.model,
    messages: req.messages,
    tools: req.tools ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface CacheRow {
  key: string;
  response: string;
  created_ms: number;
}

/** Cache de completions em SQLite (bun:sqlite), com TTL e teto de entradas. */
export class CompletionCache {
  readonly #db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_ms INTEGER NOT NULL)",
    );
  }

  /** Devolve a resposta se existir e estiver dentro do TTL; senão null. */
  get(key: string, ttlHours: number, nowMs: number = Date.now()): CompletionResponse | null {
    const row = this.#db
      .query("SELECT key, response, created_ms FROM cache WHERE key = ?")
      .get(key) as CacheRow | null;
    if (row === null) return null;
    if (ttlHours > 0 && nowMs - row.created_ms > ttlHours * 3_600_000) return null;
    return JSON.parse(row.response) as CompletionResponse;
  }

  /** Armazena a resposta; acima de maxEntries, remove a mais antiga. */
  set(key: string, response: CompletionResponse, maxEntries: number): void {
    const tx = this.#db.transaction(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO cache (key, response, created_ms) VALUES (?, ?, ?)",
        [key, JSON.stringify(response), Date.now()],
      );
      if (maxEntries > 0) {
        this.#db.run(
          `DELETE FROM cache WHERE key IN (
             SELECT key FROM cache ORDER BY created_ms ASC, key ASC LIMIT max(0, (SELECT COUNT(*) FROM cache) - ?)
           )`,
          [maxEntries],
        );
      }
    });
    tx();
  }

  /** Número de entradas (para inspeção em testes). */
  count(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM cache").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.#db.close();
  }
}

export interface CachedProviderOptions {
  cache: CompletionCache;
  ttlHours: number;
  maxEntries: number;
  /** Callback no hit (auditoria cache.hit). */
  onHit?: (key: string) => void;
}

/** Decorator de provider com cache: hit = resposta cacheada com usage zerado. */
export function cachedProvider(provider: Provider, opts: CachedProviderOptions): Provider {
  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const key = cacheKey(req);
      const hit = opts.cache.get(key, opts.ttlHours);
      if (hit !== null) {
        opts.onHit?.(key);
        // hit não gasta tokens: usage zerado → custo 0 no ledger
        return { ...hit, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const response = await provider.complete(req);
      opts.cache.set(key, response, opts.maxEntries);
      return response;
    },
  };
}