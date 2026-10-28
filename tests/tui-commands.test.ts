import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession } from "../src/chat/repl";
import type { SessionSnapshot } from "../src/chat/agent-session";
import { SessionStore } from "../src/chat/store";
import { runCommand } from "../src/tui/commands";

class FakeSession implements ChatSession {
  model = "p/m1";
  cleared = 0;
  send(): Promise<never> {
    throw new Error("não usado");
  }
  clear(): void {
    this.cleared++;
  }
  setModel(ref: string): string {
    if (ref === "ghost") throw new Error("modelo desconhecido");
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1", "p/m2"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    if (name === "ghost") throw new Error('provider "ghost" não está configurado');
    return `${name}/m1`;
  }
  resume(): void {}
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.5,
    };
  }
  close(): void {}
}

describe("comandos da TUI (T2, #63)", () => {
  test("ajuda, clear, modelo e provider produzem entradas", () => {
    const session = new FakeSession();
    const help = runCommand({ kind: "help" }, session, {});
    expect(help.entries[0]!.text).toContain("Comandos:");

    expect(runCommand({ kind: "clear" }, session, {}).entries[0]!.text).toBe("contexto limpo");
    expect(session.cleared).toBe(1);

    expect(runCommand({ kind: "model", model: "p/m2" }, session, {}).entries[0]!.text).toBe("modelo: p/m2");
    const bad = runCommand({ kind: "model", model: "ghost" }, session, {});
    expect(bad.entries[0]).toMatchObject({ kind: "error" });
    expect(bad.entries[0]!.text).toContain("modelo desconhecido");

    expect(runCommand({ kind: "providers" }, session, {}).entries[0]!.text).toContain("cred=KEY");
    expect(runCommand({ kind: "provider", provider: "p" }, session, {}).entries[0]!.text).toBe("provider: p/m1");
  });

  test("session mostra o último arquivo; sem store avisa", () => {
    const session = new FakeSession();
    const withFile = runCommand({ kind: "session" }, session, { lastFile: "/tmp/s.json" }, new SessionStore("/tmp"));
    expect(withFile.entries[0]!.text).toContain("arquivo: /tmp/s.json");
    expect(withFile.entries[0]!.text).toContain("turnos 2");
    const without = runCommand({ kind: "session" }, session, {});
    expect(without.entries[0]!.text).toContain("arquivo: sem persistência");
  });

  test("save grava sanitizado e devolve o caminho; falha vira erro", async () => {
    const session = new FakeSession();
    const dir = mkdtempSync(join(tmpdir(), "astro-tui-save-"));
    const ok = runCommand({ kind: "save" }, session, {}, new SessionStore(dir));
    expect(ok.entries[0]!.text).toMatch(/^sessão salva em /);
    expect(ok.lastFile).toBeDefined();

    const blocked = join(dir, "blocked");
    await Bun.write(blocked, "arquivo");
    const failed = runCommand({ kind: "save" }, session, {}, new SessionStore(blocked));
    expect(failed.entries[0]).toMatchObject({ kind: "error" });
    expect(failed.entries[0]!.text).toMatch(/^erro: /);
    expect(failed.lastFile).toBeNull(); // limpa o caminho anterior
  });

  test("falha de save com segredo na mensagem não vaza", () => {
    const session = new FakeSession();
    class Leaky extends SessionStore {
      override write(): string {
        throw new Error("falhou com sk-live-SEGREDO123");
      }
    }
    const outcome = runCommand({ kind: "save" }, session, {}, new Leaky(mkdtempSync(join(tmpdir(), "astro-tui-leak-"))));
    expect(outcome.entries[0]!.text).not.toContain("sk-live-SEGREDO123");
    expect(outcome.entries[0]!.text).toMatch(/^erro: /);
  });

  test("comando desconhecido e exit", () => {
    const session = new FakeSession();
    expect(runCommand({ kind: "unknown", raw: "nope" }, session, {}).entries[0]!.text).toBe("comando desconhecido: /nope");
    expect(runCommand({ kind: "exit" }, session, {}).exit).toBe(true);
  });
});
