import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, sessionSummaryLine, type SessionRecord } from "../src/chat/store";

const record = (overrides: Partial<Omit<SessionRecord, "schemaVersion">> = {}) => ({
  id: "s1",
  startedAt: "2026-10-28T12:00:00.000Z",
  model: "p/m1",
  messages: [{ role: "user" as const, content: "oi" }],
  turns: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  ...overrides,
});

describe("listar e retomar sessões (T2, #63)", () => {
  test("lista mais recentes primeiro e carrega por id", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-sessions-list-"));
    const store = new SessionStore(dir);
    store.write(record({ id: "old", startedAt: "2026-10-01T10:00:00.000Z" }));
    const newer = store.write(record({ id: "new", startedAt: "2026-10-02T10:00:00.000Z", turns: 3 }));

    const list = store.list();
    expect(list.map((item) => item.id)).toEqual(["new", "old"]);
    expect(list[0]).toMatchObject({ turns: 3, model: "p/m1" });

    const loaded = store.load("old");
    expect(loaded.record.id).toBe("old");
    expect(loaded.record.messages).toHaveLength(1);
    expect(loaded.path.endsWith("old.json")).toBe(true);
    expect(store.load("new").path).toBe(newer);
  });

  test("ignora arquivo corrompido e recusa caminho fora do diretório", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-sessions-bad-"));
    const store = new SessionStore(dir);
    store.write(record({ id: "ok" }));
    writeFileSync(join(dir, "broken.json"), "{não é json", "utf8");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ schemaVersion: 2 }), "utf8");

    expect(store.list().map((item) => item.id)).toEqual(["ok"]);
    expect(() => store.load("broken")).toThrow(/não encontrada/);
    expect(() => store.load("../escape.json")).toThrow(/não encontrada|fora do diretório/);
    expect(store.load(store.list()[0]!.path).record.id).toBe("ok");
  });

  test("linha de resumo numera e mostra turnos/custo", () => {
    const line = sessionSummaryLine(
      { path: "/tmp/a.json", id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: "p/m1", turns: 2, costUsd: 0.5 },
      0,
    );
    expect(line.startsWith("1. 2026-10-28T12:00:00.000Z s1 p/m1 turnos=2")).toBe(true);
    expect(line).toContain("custo=US$ 0.500000");
  });
});

/** Liga diretório (junction no Windows) para testar escape por link; false se o SO recusar. */
function supportsDirectoryLink(): boolean {
  const root = mkdtempSync(join(tmpdir(), "astro-link-probe-"));
  const target = mkdtempSync(join(tmpdir(), "astro-link-target-"));
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

describe("confinamento e validação ao ler sessões (T2, #63)", () => {
  test("não lê sessão via junction/symlink para fora do diretório", () => {
    if (!supportsDirectoryLink()) return;
    const root = mkdtempSync(join(tmpdir(), "astro-sessions-link-"));
    const outside = mkdtempSync(join(tmpdir(), "astro-sessions-out-"));
    writeFileSync(join(outside, "evil.json"), JSON.stringify({
      schemaVersion: 1, id: "evil", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "externo" }], turns: 1, tokensIn: 1, tokensOut: 1, costUsd: null,
    }), "utf8");
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const store = new SessionStore(root);
    expect(() => store.load("link/evil.json")).toThrow(/fora do diretório/);
  });

});