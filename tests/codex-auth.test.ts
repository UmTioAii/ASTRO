import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAuth, refreshCodexTokens } from "../src/provider/codex-auth";

const dir = () => mkdtempSync(join(tmpdir(), "astro-codex-"));
const jwt = (payload: object) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

test("lê auth.json e extrai tokens/expiração", () => {
  const path = join(dir(), "auth.json");
  writeFileSync(path, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }), access_token: jwt({ exp: 4102444800 }), refresh_token: "r1" },
  }));
  const t = readCodexAuth(path);
  expect(t.accessToken.split(".")).toHaveLength(3);
  expect(t.refreshToken).toBe("r1");
  expect(t.accountId).toBe("acct_1");
  expect(t.expiresAt).toBe(4102444800);
});

test("auth ausente → erro claro sem conteúdo", () => {
  expect(() => readCodexAuth(join(dir(), "nope.json"))).toThrow(/auth\.json|credenciais/i);
});

test("refresh renova em memória", async () => {
  const fetchFn = async (_url: string, init?: RequestInit) => {
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    return Response.json({ access_token: jwt({ exp: 4102444800 }), refresh_token: "r2", expires_in: 3600 });
  };
  const t = await refreshCodexTokens({ accessToken: jwt({ exp: 1 }), refreshToken: "r1", accountId: "a", expiresAt: 1 }, fetchFn);
  expect(t.refreshToken).toBe("r2");
  expect(t.expiresAt).toBeGreaterThan(4_000_000_000);
});

test("refresh envia client_id e content-type de formulário", async () => {
  let seen: RequestInit | undefined;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    seen = init;
    return Response.json({ access_token: jwt({ exp: 4102444800 }), refresh_token: "r2" });
  };
  await refreshCodexTokens(
    { accessToken: jwt({ exp: 1 }), refreshToken: "r1", accountId: "a", expiresAt: 1 },
    fetchFn,
  );
  expect(new Headers(seen?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
  const body = String(seen?.body);
  expect(body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
  expect(body).toContain("refresh_token=r1");
});
