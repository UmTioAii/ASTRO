import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateProvider } from "../src/tui/app";
import type { SessionSnapshot } from "../src/chat/agent-session";

test("falha ao persistir o último modelo não desfaz a ativação", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-last-model-"));
  const file = join(dir, "arquivo"); // cwd é um arquivo: .astro/tui.json não pode ser criado
  writeFileSync(file, "x");
  const calls: string[] = [];
  const warnings: string[] = [];
  const session = {
    reload: () => calls.push("reload"),
    setProvider: (id: string) => {
      calls.push(`use:${id}`);
      return `${id}/m1`;
    },
    snapshot: () => ({ model: "p/m1" } as SessionSnapshot),
  };

  expect(() => activateProvider(session, file, "p", (text) => warnings.push(text))).not.toThrow();
  expect(calls).toEqual(["reload", "use:p"]);
  expect(warnings[0]).toContain("aviso");
  expect(warnings[0]).toContain("último modelo");
});
