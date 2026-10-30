import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, ConfigError } from "../src/config";
import { CompletionCache, cacheKey, cachedProvider } from "../src/cache";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/provider/types";

const baseConfig = {
  providers: { openai: { kind: "openai-compat" as const, baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const req = (p: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "diga oi" }],
  ...p,
});
const resp = (p: Partial<CompletionResponse> = {}): CompletionResponse => ({
  content: "oi", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});

function makeCache(): CompletionCache {
  return new CompletionCache(join(mkdtempSync(join(tmpdir(), "astro-cache-")), "cache.db"));
}

describe("config cache (F6-4)", () => {
  test("sem seção → undefined; com {} → defaults off/24h/10000", () => {
    expect(validateConfig(structuredClone(baseConfig)).cache).toBeUndefined();
    const cfg = validateConfig({ ...structuredClone(baseConfig), cache: {} });
    expect(cfg.cache).toEqual({ enabled: false, ttlHours: 24, maxEntries: 10000 });
  });

  test("enabled true + valores custom aceitos", () => {
    const cfg = validateConfig({ ...structuredClone(baseConfig), cache: { enabled: true, ttlHours: 1, maxEntries: 5 } });
    expect(cfg.cache).toEqual({ enabled: true, ttlHours: 1, maxEntries: 5 });
  });

  test("valores inválidos → ConfigError", () => {
    expect(() => validateConfig({ ...structuredClone(baseConfig), cache: { ttlHours: -1 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...structuredClone(baseConfig), cache: { maxEntries: 0 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...structuredClone(baseConfig), cache: { enabled: "x" } })).toThrow(ConfigError);
  });
});

describe("cacheKey (F6-4)", () => {
  test("determinística: mesma request, mesma chave", () => {
    expect(cacheKey(req())).toBe(cacheKey(req()));
  });

  test("modelo diferente → chave diferente", () => {
    expect(cacheKey(req())).not.toBe(cacheKey(req({ model: "outro" })));
  });

  test("profile diferente → chave diferente (F-31)", () => {
    expect(cacheKey(req())).not.toBe(cacheKey(req({ profile: "p1" })));
  });

  test("mensagem diferente → chave diferente", () => {
    expect(cacheKey(req())).not.toBe(
      cacheKey(req({ messages: [{ role: "user", content: "diga tchau" }] })),
    );
  });

  test("tools diferentes → chave diferente", () => {
    expect(cacheKey(req())).not.toBe(
      cacheKey(req({ tools: [{ name: "t", description: "d", parameters: {} }] })),
    );
  });

  test("call (lvl/thinking) diferente → chave diferente (E1)", () => {
    expect(cacheKey(req())).not.toBe(cacheKey(req({ call: { lvl: 4 } })));
    expect(cacheKey(req({ call: { lvl: 4 } }))).not.toBe(cacheKey(req({ call: { lvl: 0 } })));
    expect(cacheKey(req({ call: { lvl: 4, thinking: "on" } }))).not.toBe(
      cacheKey(req({ call: { lvl: 4, thinking: "off" } })),
    );
  });
});

describe("CompletionCache (F6-4)", () => {
  test("set/get roundtrip em SQLite", () => {
    const cache = makeCache();
    try {
      cache.set("k1", resp(), 100);
      expect(cache.get("k1", 24)).toEqual(resp());
      expect(cache.get("k2", 24)).toBeNull();
      expect(cache.count()).toBe(1);
    } finally {
      cache.close();
    }
  });

  test("TTL expirado → null", () => {
    const cache = makeCache();
    try {
      cache.set("k1", resp(), 100);
      // nowMs 25h depois → expirado com ttl 24h
      expect(cache.get("k1", 24, Date.now() + 25 * 3_600_000)).toBeNull();
      // ttl 0 = sem expiração
      expect(cache.get("k1", 0, Date.now() + 100 * 3_600_000)).not.toBeNull();
    } finally {
      cache.close();
    }
  });

  test("maxEntries evicta a mais antiga", () => {
    const cache = makeCache();
    try {
      cache.set("a", resp({ content: "a" }), 2);
      cache.set("b", resp({ content: "b" }), 2);
      cache.set("c", resp({ content: "c" }), 2); // evicta "a"
      expect(cache.count()).toBe(2);
      expect(cache.get("a", 24)).toBeNull();
      expect(cache.get("b", 24)).not.toBeNull();
      expect(cache.get("c", 24)).not.toBeNull();
    } finally {
      cache.close();
    }
  });
});

describe("cachedProvider (F6-4)", () => {
  test("miss executa e armazena; hit devolve cache com usage zerado sem chamar o provider", async () => {
    const cache = makeCache();
    try {
      let calls = 0;
      const inner: Provider = { complete: async () => { calls++; return resp(); } };
      const hits: string[] = [];
      const wrapped = cachedProvider(inner, {
        cache, ttlHours: 24, maxEntries: 100, onHit: (key) => hits.push(key),
      });

      // miss: executa
      const first = await wrapped.complete(req());
      expect(calls).toBe(1);
      expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

      // hit: não executa, usage zerado (custo 0 no ledger)
      const second = await wrapped.complete(req());
      expect(calls).toBe(1);
      expect(second.content).toBe("oi");
      expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBe(cacheKey(req()));
    } finally {
      cache.close();
    }
  });

  test("call diferente é miss separado e não devolve resposta de outro lvl (E1)", async () => {
    const cache = makeCache();
    try {
      let calls = 0;
      const inner: Provider = {
        complete: async (request) => { calls++; return resp({ content: `lvl-${request.call?.lvl ?? "none"}` }); },
      };
      const wrapped = cachedProvider(inner, { cache, ttlHours: 24, maxEntries: 100 });

      expect((await wrapped.complete(req({ call: { lvl: 4 } }))).content).toBe("lvl-4");
      expect((await wrapped.complete(req({ call: { lvl: 0 } }))).content).toBe("lvl-0");
      expect(calls).toBe(2);
      // mesma call volta a acertar o cache
      expect((await wrapped.complete(req({ call: { lvl: 4 } }))).content).toBe("lvl-4");
      expect(calls).toBe(2);
    } finally {
      cache.close();
    }
  });

  test("scope por request separa profiles/configs e hit não ecoa call", async () => {
    const cache = makeCache();
    try {
      let calls = 0;
      const inner: Provider = {
        complete: async (request) => {
          calls++;
          return resp({ content: `${request.profile ?? "base"}-${calls}`, call: { lvl: 4, effort: "ultra", stripped: [] } });
        },
      };
      const wrapped = cachedProvider(inner, {
        cache,
        scope: (request) => `scope|${request.profile ?? "base"}`,
        ttlHours: 24,
        maxEntries: 100,
      });

      const first = await wrapped.complete(req({ profile: "a" }));
      expect(first.content).toBe("a-1");
      expect(first.call).toMatchObject({ lvl: 4 });

      const hit = await wrapped.complete(req({ profile: "a" }));
      expect(hit.content).toBe("a-1");
      expect(calls).toBe(1);
      expect(hit.call).toBeUndefined(); // nada foi enviado neste hit

      await wrapped.complete(req({ profile: "b" }));
      expect(calls).toBe(2);
    } finally {
      cache.close();
    }
  });

  test("scope separa providers com o mesmo request (sem hit cruzado)", async () => {
    const cache = makeCache();
    try {
      let a = 0;
      let b = 0;
      const wa = cachedProvider({ complete: async () => { a++; return resp(); } },
        { cache, scope: "a/m1", ttlHours: 24, maxEntries: 100 });
      const wb = cachedProvider({ complete: async () => { b++; return resp(); } },
        { cache, scope: "b/m1", ttlHours: 24, maxEntries: 100 });
      await wa.complete(req());
      await wb.complete(req());
      expect([a, b]).toEqual([1, 1]); // cada escopo tem sua entrada
      await wa.complete(req());
      expect([a, b]).toEqual([1, 1]); // hit no escopo certo
    } finally {
      cache.close();
    }
  });

  test("request diferente é miss separado", async () => {
    const cache = makeCache();
    try {
      let calls = 0;
      const inner: Provider = { complete: async () => { calls++; return resp(); } };
      const wrapped = cachedProvider(inner, { cache, ttlHours: 24, maxEntries: 100 });
      await wrapped.complete(req());
      await wrapped.complete(req({ messages: [{ role: "user", content: "outra" }] }));
      expect(calls).toBe(2);
    } finally {
      cache.close();
    }
  });
});