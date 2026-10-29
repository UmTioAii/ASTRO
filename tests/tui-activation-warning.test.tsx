import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import type { ChatSession } from "../src/chat/repl";
import { validateConfig } from "../src/config";
import { ProfileManager } from "../src/provider/profile-manager";
import { TuiApp } from "../src/tui/app";

class Session implements ChatSession {
  model = "p/m1";
  activated: string[] = [];

  async send(prompt: string): Promise<TurnResult> {
    return {
      final: prompt, model: this.model, steps: 1, tokensIn: 1, tokensOut: 1, costUsd: 0.001,
      totalTokensIn: 1, totalTokensOut: 1, totalCostUsd: 0.001, contextTokens: 1, contextLimit: 100,
      contextRatio: 0.01, warning: false, trimmed: false,
    };
  }
  compact(): Promise<string> { return Promise.resolve("não usado"); }
  clear(): void {}
  resume(_snapshot: SessionSnapshot): void {}
  setModel(ref: string): string { this.model = ref; return ref; }
  listModels(): string[] { return ["p/m1"]; }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    this.activated.push(name);
    this.model = `${name}/m1`;
    return this.model;
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-29T00:00:00.000Z", model: this.model,
      messages: [], turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }
  close(): void {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

function manager(): ProfileManager {
  const project = validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
  const home = mkdtempSync(join(tmpdir(), "astro-tui-activation-home-"));
  return new ProfileManager({ project, env: { ASTRO_HOME: home } });
}

test("falha ao persistir na ativação vira aviso e não desfaz a troca", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-activation-"));
  writeFileSync(join(cwd, ".astro"), "não é diretório", "utf8"); // saveTuiConfig falha
  const session = new Session();
  const instance = render(<TuiApp session={session} cwd={cwd} manager={manager()} />);
  try {
    instance.stdin.write("/provider");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("ativo: p") === true);
    expect(session.activated).toEqual(["p"]);
    expect(session.model).toBe("p/m1");

    instance.stdin.write("\u001B");
    await waitFor(() => instance.lastFrame()?.includes("aviso:") === true);
    expect(instance.lastFrame()).toContain("provider: p/m1");
  } finally {
    instance.unmount();
  }
});
