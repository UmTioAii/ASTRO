import { expect, test } from "bun:test";
import type { AstroConfig } from "../src/config";
import { validateConfig } from "../src/config";
import { Registry } from "../src/registry";

const cfg: AstroConfig = validateConfig({
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [
    { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 },
    { provider: "openai", id: "old-model", tags: ["fast"], context: 8192, status: "deprecated" },
  ],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
});

test("get devolve por chave provider/id (qualquer status)", () => {
  const r = new Registry(cfg);
  expect(r.get("openai/gpt-4o-mini")?.id).toBe("gpt-4o-mini");
  expect(r.get("openai/old-model")?.status).toBe("deprecated");
  expect(r.get("openai/ghost")).toBeUndefined();
});

test("require exige status active", () => {
  const r = new Registry(cfg);
  expect(r.require("openai/gpt-4o-mini").id).toBe("gpt-4o-mini");
  expect(() => r.require("openai/old-model")).toThrow(/active|old-model/);
  expect(() => r.require("openai/ghost")).toThrow(/openai\/ghost/);
});

test("list devolve só active e filtra por tag", () => {
  const r = new Registry(cfg);
  expect(r.list().map((m) => m.id)).toEqual(["gpt-4o-mini"]);
  expect(r.list({ tags: ["tools"] }).map((m) => m.id)).toEqual(["gpt-4o-mini"]);
  expect(r.list({ tags: ["nonexistent"] })).toEqual([]);
});
