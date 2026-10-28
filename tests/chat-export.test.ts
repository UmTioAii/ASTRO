import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPath, exportSession, renderMarkdown } from "../src/chat/export";
import { AGENTS_TEMPLATE, initAgents } from "../src/chat/init";
import type { SessionSnapshot } from "../src/chat/agent-session";

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "s1",
  startedAt: "2026-10-28T12:00:00.000Z",
  model: "p/m1",
  messages: [
    { role: "system", content: "instruções privadas" },
    { role: "user", content: "olá" },
    { role: "assistant", content: "oi", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
  ],
  turns: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  ...overrides,
});

describe("exportar sessão em Markdown (T2, #63)", () => {
  test("inclui metadados, papéis e tool calls; omite o system", () => {
    const markdown = renderMarkdown(snapshot());
    expect(markdown).toContain("# Sessão s1");
    expect(markdown).toContain("- Modelo: p/m1");
    expect(markdown).toContain("## Usuário");
    expect(markdown).toContain("## Assistente");
    expect(markdown).toContain("read_file");
    expect(markdown).not.toContain("instruções privadas");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  test("grava em .astro/exports com nome estável e modo restrito", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-export-"));
    const path = exportSession(snapshot(), cwd);
    expect(path).toContain(join(".astro", "exports"));
    expect(path.endsWith("2026-10-28T12-00-00-000Z-s1.md")).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("olá");
  });

  test("aceita caminho relativo dentro do cwd e recusa fora", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-export-rel-"));
    const path = exportSession(snapshot(), cwd, "notas/transcript.md");
    expect(path).toBe(join(cwd, "notas", "transcript.md"));
    expect(existsSync(path)).toBe(true);
    expect(exportPath(cwd, snapshot(), "ok.md").startsWith(cwd)).toBe(true);
    expect(() => exportPath(cwd, snapshot(), "../escape.md")).toThrow(/fora do cwd/);
    expect(() => exportPath(cwd, snapshot(), join(tmpdir(), "abs.md"))).toThrow(/fora do cwd/);
  });
});

describe("/init cria AGENTS.md sem sobrescrever (T2, #63)", () => {
  test("cria com o template e recusa a segunda vez", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-init-"));
    const path = initAgents(cwd);
    expect(path).toBe(join(cwd, "AGENTS.md"));
    expect(readFileSync(path, "utf8")).toBe(AGENTS_TEMPLATE);
    expect(() => initAgents(cwd)).toThrow(/já existe/);
  });

  test("não altera um AGENTS.md existente", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-init-keep-"));
    const path = join(cwd, "AGENTS.md");
    writeFileSync(path, "meu conteúdo", "utf8");
    expect(() => initAgents(cwd)).toThrow(/já existe/);
    expect(readFileSync(path, "utf8")).toBe("meu conteúdo");
  });
});
function supportsDirectoryLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), "astro-export-probe-"));
  const target = mkdtempSync(join(tmpdir(), "astro-export-target-"));
  try {
    symlinkSync(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

describe("confinamento da exportação (T2, #63)", () => {
  test("recusa junction/symlink para fora e o diretório de sessões", () => {
    if (!supportsDirectoryLink()) return;
    const cwd = mkdtempSync(join(tmpdir(), "astro-export-link-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-export-out-"));
    symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => exportSession(snapshot(), cwd, "link/escape.md")).toThrow(/fora do cwd/);
    expect(existsSync(join(outside, "escape.md"))).toBe(false);
    expect(() => exportSession(snapshot(), cwd, join(".astro", "sessions", "x.json"))).toThrow(/reservado/);
  });

  test("redige segredo nos argumentos da tool call", () => {
    const markdown = renderMarkdown(snapshot({
      messages: [{
        role: "assistant", content: "x",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"api_key\":\"sk-live-SECRETO\"}" }],
      }],
    }));
    expect(markdown).toContain("read_file");
    expect(markdown).not.toContain("sk-live-SECRETO");
  });

  test("não sobrescreve arquivo existente e protege o estado do harness", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-export-safe-"));
    writeFileSync(join(cwd, "README.md"), "original", "utf8");
    expect(() => exportSession(snapshot(), cwd, "README.md")).toThrow(/já existe/);
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("original");
    expect(() => exportSession(snapshot(), cwd, join(".astro", "audit.jsonl"))).toThrow(/reservado/);

    const first = exportSession(snapshot(), cwd);
    exportSession(snapshot(), cwd); // o destino padrão pode ser reescrito
    expect(readFileSync(first, "utf8")).toContain("olá");
  });
  test("reserva .astro também em caixa diferente no filesystem case-insensitive", () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const cwd = mkdtempSync(join(tmpdir(), "astro-export-case-"));
    expect(() => exportSession(snapshot(), cwd, ".ASTRO/sessions/fake.json")).toThrow(/reservado/);
    expect(() => exportSession(snapshot(), cwd, ".astro./sessions/fake.json")).toThrow(/reservado/);
    expect(() => exportSession(snapshot(), cwd, ".astro /sessions/fake.json")).toThrow(/reservado/);
  });
});
