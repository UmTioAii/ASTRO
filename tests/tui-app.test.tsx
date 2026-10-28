import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TuiApp } from "../src/tui/app";
import type { ChatSession } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: string[] = [];
  cleared = 0;
  failNext = false;
  async send(prompt: string): Promise<TurnResult> {
    this.sent.push(prompt);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    return {
      final: `eco:${prompt}`, model: this.model, steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
      totalTokensIn: 10 * this.sent.length, totalTokensOut: 5 * this.sent.length,
      totalCostUsd: 0.001 * this.sent.length, contextTokens: 10, contextLimit: 100, contextRatio: 0.1,
      warning: false, trimmed: false,
    };
  }
  clear(): void {
    this.cleared++;
  }
  setModel(ref: string): string {
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    return `${name}/m1`;
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }], turns: this.sent.length,
      tokensIn: 10 * this.sent.length, tokensOut: 5 * this.sent.length, costUsd: 0.001,
    };
  }
  close(): void {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("mostra boas-vindas, status e responde um turno", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" branch="main" />);
  try {
    expect(instance.lastFrame()).toContain("astro tui");
    expect(instance.lastFrame()).toContain("/tmp/astro (main)");
    expect(instance.lastFrame()).toContain("p/m1");

    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:olá") === true);
    expect(instance.lastFrame()).toContain("1 step(s)");
    expect(session.sent).toEqual(["olá"]);
    expect(instance.lastFrame()).toContain("1 turno(s)");
  } finally {
    instance.unmount();
  }
});

test("comandos /help, /model e /clear aparecem no painel", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" />);
  try {
    instance.stdin.write("/help");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Comandos:") === true);

    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);

    instance.stdin.write("/clear");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("contexto limpo") === true);
    expect(session.cleared).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("/exit encerra e erro de turno não fecha a TUI", async () => {
  const session = new FakeSession();
  let exits = 0;
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    session.failNext = true;
    instance.stdin.write("falha");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro: boom") === true);
    expect(exits).toBe(0);

    instance.stdin.write("depois");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:depois") === true);

    instance.stdin.write("/exit");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
  } finally {
    instance.unmount();
  }
});
