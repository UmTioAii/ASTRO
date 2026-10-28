import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../src/chat/store";

const snapshot = (overrides: Partial<Omit<SessionRecord, "schemaVersion">> = {}) => ({
  id: "s1",
  startedAt: "2026-10-28T12:00:00.000Z",
  model: "p/m1",
  messages: [{ role: "user" as const, content: "oi" }, { role: "assistant" as const, content: "olá" }],
  turns: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
  ...overrides,
});

describe("store de sessão do chat (T1, #62)", () => {
  test("grava schema 1 em arquivo atômico nomeado pelo startedAt+id", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot());
    expect(path.endsWith("2026-10-28T12-00-00-000Z-s1.json")).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    expect(record).toMatchObject({ schemaVersion: 1, id: "s1", model: "p/m1", turns: 1, costUsd: 0.001 });
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("sanitiza segredo na escrita", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot({
      messages: [{ role: "user", content: "Authorization: Bearer sk-abc123segredo" }],
    }));
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("sk-abc123segredo");
    expect(text).toContain("REDACTED");
  });
});
