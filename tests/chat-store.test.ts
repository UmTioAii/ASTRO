import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../src/chat/store";
import { redactSecrets } from "../src/sanitize-external";
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
    expect(record).toMatchObject({ schemaVersion: 1, model: "p/m1", turns: 1, costUsd: 0.001 });
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  test("sanitiza segredo na escrita (env-like, JSON aninhado e toolCalls)", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const path = new SessionStore(dir).write(snapshot({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "run_command",
          arguments: JSON.stringify({ apiKey: "abcd1234efgh5678", nested: { password: "hunter2xyz" },
            secretKey: "svSECRET", passwordHash: "phSECRET", refresh_token_value: "rtvSECRET" }) }] },
        { role: "user", content: 'GITHUB_TOKEN="ghp_abc12345678" x-api-key: abcd1234efgh5678 TOKEN="abc123456789"' },
      ],
    }));
    const text = readFileSync(path, "utf8");
    for (const secret of ["abcd1234efgh5678", "hunter2xyz", "ghp_abc12345678", "abc123456789", "svSECRET", "phSECRET", "rtvSECRET"]) {
      expect(text).not.toContain(secret);
    }
    expect(() => JSON.parse(text)).not.toThrow();
  });
  test("recusa id/startedAt que escapariam do diretório", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-store-"));
    const store = new SessionStore(dir);
    expect(() => store.write(snapshot({ id: "..\\..\\escape" }))).toThrow(/inválido/);
    expect(() => store.write(snapshot({ startedAt: "../../x" }))).toThrow(/inválido/);
  });
  test("redactSecrets cobre aspas escapadas sem deixar o valor", () => {
    const text = redactSecrets('{\\"TOKEN\\":\\"abc123456789\\"}');
    expect(text).not.toContain("abc123456789");
    expect(text).toContain("[REDACTED]");
  });
  test("redactSecrets preserva tokens do artefato e redige env", () => {
    const text = redactSecrets('{"token":123,"tokens":7,"refresh_token_value":"abc"}');
    expect(text).not.toContain("123");
    expect(text).not.toContain("abc");
    expect(text).toContain('"tokens":7');
  });
});
