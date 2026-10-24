import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubConfigRegistry, isValidSemver } from "../src/config-share";
import { validateConfig, ConfigError } from "../src/config";

const validConfig = {
  version: "1.2.0",
  providers: { mock: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "TEST_KEY" } },
  models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 4096 }],
  agent: { model: "mock/m1", maxSteps: 3, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

/** Mock do GitHub Contents API: guarda arquivos em memória. */
function mockRegistry() {
  const files = new Map<string, { content: string; sha: string }>();
  const requests: Array<{ method: string; path: string; auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      requests.push({ method: req.method, path, auth: req.headers.get("authorization") });
      const match = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path);
      if (match === null) return new Response("nope", { status: 404 });

      if (req.method === "GET") {
        const file = files.get(match[3]!);
        if (file === undefined) return new Response("not found", { status: 404 });
        return Response.json({ content: file.content, encoding: "base64", sha: file.sha });
      }
      if (req.method === "PUT") {
        const body = JSON.parse(await req.text()) as { content: string; sha?: string };
        const existing = files.get(match[3]!);
        if (existing !== undefined && body.sha !== existing.sha) {
          return new Response("conflict", { status: 409 });
        }
        const sha = `sha-${Math.random().toString(36).slice(2, 10)}`;
        files.set(match[3]!, { content: body.content, sha });
        return Response.json({ content: { sha } }, { status: existing === undefined ? 201 : 200 });
      }
      return new Response("nope", { status: 405 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    files,
    requests,
    stop: () => server.stop(true),
  };
}

function makeRegistry(baseUrl: string): GitHubConfigRegistry {
  return new GitHubConfigRegistry({ owner: "org", repo: "astro-configs", token: "tok", baseUrl });
}

describe("isValidSemver (F7-4)", () => {
  test("aceita x.y.z; rejeita o resto", () => {
    expect(isValidSemver("1.2.0")).toBe(true);
    expect(isValidSemver("0.0.1")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("1.2.3-beta")).toBe(false);
    expect(isValidSemver("x.y.z")).toBe(false);
  });
});

describe("config version (F7-4)", () => {
  test("version válida aceita na config", () => {
    const cfg = validateConfig(structuredClone(validConfig));
    expect(cfg.version).toBe("1.2.0");
  });

  test("version inválida → ConfigError", () => {
    const bad = structuredClone(validConfig) as Record<string, unknown>;
    bad.version = "1.2";
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });
});

describe("GitHubConfigRegistry (F7-4)", () => {
  test("push cria e atualiza (fluxo sha); pull devolve o conteúdo", async () => {
    const mock = mockRegistry();
    try {
      const registry = makeRegistry(mock.baseUrl);
      const json = JSON.stringify(validConfig, null, 2) + "\n";

      // cria
      const created = await registry.push("team/app", json);
      expect(created.created).toBe(true);

      // atualiza (com sha do GET)
      const updated = await registry.push("team/app", json.replace("1.2.0", "1.3.0"));
      expect(updated.created).toBe(false);

      // pull devolve a versão nova
      const pulled = await registry.pull("team/app");
      const parsed = JSON.parse(pulled) as { version: string };
      expect(parsed.version).toBe("1.3.0");
      // credentialRef é NOME da variável (permitido); valor de segredo nunca existe na config
      expect(pulled).toContain("credentialRef");

      // autenticação em toda requisição
      expect(mock.requests.every((r) => r.auth === "Bearer tok")).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("pull de config inexistente → erro claro", async () => {
    const mock = mockRegistry();
    try {
      const registry = makeRegistry(mock.baseUrl);
      const err = await registry.pull("fantasma").then(() => null, (e) => e as Error);
      expect(err!.message).toContain("não encontrada");
    } finally {
      mock.stop();
    }
  });

  test("fluxo completo: push de uma config e pull valida e grava local", async () => {
    const mock = mockRegistry();
    const dir = mkdtempSync(join(tmpdir(), "astro-share-"));
    try {
      // lado A: publica a config local
      const localPath = join(dir, "astro.config.json");
      writeFileSync(localPath, JSON.stringify(validConfig, null, 2), "utf8");
      const registry = makeRegistry(mock.baseUrl);
      const raw = JSON.parse(readFileSync(localPath, "utf8")) as unknown;
      validateConfig(raw);
      await registry.push("team/astro", JSON.stringify(raw, null, 2) + "\n");

      // lado B: outro membro puxa, valida e grava
      const pulled = await registry.pull("team/astro");
      const remote = JSON.parse(pulled) as unknown;
      const cfg = validateConfig(remote); // inválida não chegaria ao disco
      expect(cfg.version).toBe("1.2.0");
      const targetPath = join(dir, "pulled.config.json");
      writeFileSync(targetPath, pulled, "utf8");
      expect(JSON.parse(readFileSync(targetPath, "utf8") as string)).toEqual(validConfig);
    } finally {
      mock.stop();
    }
  });
});