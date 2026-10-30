import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiApp } from "../src/tui/app";
import { SessionStore } from "../src/chat/store";
import type { ChatSession } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import { BudgetExceededError } from "../src/budget";
import { createApprovalBridge } from "../src/tui/approvals";

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: string[] = [];
  cleared = 0;
  failNext = false;
  compact(): Promise<string> {
    return Promise.resolve("não usado");
  }
  async send(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    this.sent.push(prompt);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    void signal;
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
  healthCalls = 0;
  health() {
    this.healthCalls++;
    return Promise.resolve({ status: "degraded" as const, checks: [] });
  }
  providerName(): string {
    return "p";
  }
  resumed: string[] = [];
  resumedFrom: { id: string; startedAt: string } | undefined;
  resume(snapshot: SessionSnapshot): void {
    this.resumed.push(snapshot.id);
    this.resumedFrom = { id: snapshot.id, startedAt: snapshot.startedAt };
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }], turns: this.sent.length,
      tokensIn: 10 * this.sent.length, tokensOut: 5 * this.sent.length, costUsd: 0.001,
      ...(this.resumedFrom === undefined ? {} : { resumedFrom: this.resumedFrom }),
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

test("status bar mostra saúde n/d e atualiza após troca de provider", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-health-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => instance.lastFrame()?.includes("saúde: n/d") === true);
    expect(session.healthCalls).toBe(0);
    instance.stdin.write("/provider use p");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("saúde: degraded") === true);
    expect(session.healthCalls).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("comandos /help, /model e /clear aparecem no painel", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-help-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
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

test("falha ao gravar a config não derruba a TUI", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-bad-config-"));
  writeFileSync(join(cwd, ".astro"), "não é diretório", "utf8");
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    await waitFor(() => instance.lastFrame()?.includes("erro:") === true);
  } finally { instance.unmount(); }
});

test("ctrl+c durante o turno aborta e encerra depois", async () => {
  class Slow extends FakeSession {
    aborted = false;
    override async send(_prompt: string, signal?: AbortSignal): Promise<TurnResult> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => {
          this.aborted = true;
          clearTimeout(timer);
          reject(new Error("cancelado"));
        });
      });
      return { ...(await super.send("depois")) };
    }
  }
  const session = new Slow();
  let exits = 0;
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("demora");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    expect(exits).toBe(0);

    instance.stdin.write("\u0003");
    await waitFor(() => exits === 1);
    expect(session.aborted).toBe(true);
    expect(instance.lastFrame()).toContain("erro: cancelado");
  } finally {
    instance.unmount();
  }
});

test("erro fatal de sessão encerra a TUI", async () => {
  class Fatal extends FakeSession {
    override async send(): Promise<TurnResult> {
      throw new Error("budget", { cause: new BudgetExceededError("limit", {} as never) });
    }
  }
  let exits = 0;
  const instance = render(<TuiApp session={new Fatal()} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("x");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
    expect(instance.lastFrame()).toContain("erro: budget");
  } finally {
    instance.unmount();
  }
});

test("ignora Enter durante o turno e atualiza o status após /model", async () => {
  class Slow extends FakeSession {
    override async send(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return super.send(prompt, signal);
    }
  }
  const session = new Slow();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-busy-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("demora");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    instance.stdin.write("outra");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:demora") === true);
    expect(session.sent).toEqual(["demora"]);

    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    expect(instance.lastFrame()).toMatch(/p\/m2 · 1 turno\(s\)/);
  } finally {
    instance.unmount();
  }
});

test("falha de gravação limpa o caminho mostrado por /session", async () => {
  class Flaky extends SessionStore {
    calls = 0;
    override write(snapshot: Parameters<SessionStore["write"]>[0]): string {
      this.calls++;
      if (this.calls > 1) throw new Error("disco cheio");
      return super.write(snapshot);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-store-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" store={new Flaky(dir)} />);
  try {
    instance.stdin.write("/save");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sessão salva em") === true);

    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro: disco cheio") === true);

    instance.stdin.write("/session");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("ainda não salvo") === true);
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

test("pergunta de aprovação aparece no painel e libera o turno", async () => {
  const bridge = createApprovalBridge();
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" approvals={bridge} />);
  try {
    const decision = bridge.approveSwap({
      run: "r", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" }, reason: "fallback",
    });
    await waitFor(() => instance.lastFrame()?.includes("aprovar? [s/N]") === true);
    instance.stdin.write("s");
    instance.stdin.write("\r");
    expect(await decision).toBe(true);
    expect(instance.lastFrame()?.includes("aprovar? [s/N]")).toBe(false);
  } finally {
    instance.unmount();
  }
});

test("/exit grava a sessão sanitizada antes de fechar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-exit-"));
  let exits = 0;
  const instance = render(
    <TuiApp session={new FakeSession()} cwd="/tmp/astro" store={new SessionStore(dir)} onExit={() => { exits++; }} />,
  );
  try {
    instance.stdin.write("/exit");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
    expect(readdirSync(dir).some((name) => name.endsWith(".json"))).toBe(true);
  } finally {
    instance.unmount();
  }
});

test("segundo ctrl+c força a saída mesmo com o provider travado", async () => {
  class Stuck extends FakeSession {
    override send(): Promise<TurnResult> {
      return new Promise(() => {});
    }
  }
  let exits = 0;
  const instance = render(<TuiApp session={new Stuck()} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("trava");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    instance.stdin.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exits).toBe(0);
    instance.stdin.write("\u0003");
    await waitFor(() => exits === 1);
  } finally {
    instance.unmount();
  }
});
test("/sessions e /resume no painel compartilham a lista", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-panel-sessions-"));
  const store = new SessionStore(dir);
  store.write({
    id: "xyz", startedAt: "2026-10-02T10:00:00.000Z", model: "p/m1",
    messages: [{ role: "user", content: "guardado" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.002,
  });
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-resume-"));
  const instance = render(<TuiApp session={session} cwd={cwd} store={store} />);
  try {
    instance.stdin.write("/sessions");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("xyz") === true);

    // arquivo novo aparece depois da lista exibida: /resume 1 deve usar a lista vista
    store.write({
      id: "zzz", startedAt: "2026-10-03T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "novo" }], turns: 1, tokensIn: 1, tokensOut: 1, costUsd: null,
    });

    instance.stdin.write("/resume 1");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sessão retomada: xyz") === true);
    expect(session.resumed).toEqual(["xyz"]);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { lastModel?: string };
    expect(config.lastModel).toBe("p/m1");

    instance.stdin.write("/session");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("retomada de xyz") === true);
  } finally {
    instance.unmount();
  }
});
test("Tab completa comando e @arquivo no painel", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-complete-"));
  writeFileSync(join(cwd, "notas.md"), "# notas", "utf8");
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/re");
    await waitFor(() => instance.lastFrame()?.includes("/resume") === true);
    instance.stdin.write("\t");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sem persistência configurada") === true);

    instance.stdin.write("leia @not");
    await waitFor(() => instance.lastFrame()?.includes("@notas.md") === true);
    instance.stdin.write("\t");
    await waitFor(() => instance.lastFrame()?.includes("leia @notas.md") === true);
    instance.stdin.write("\r");
    await waitFor(() => session.sent.includes("leia @notas.md") === true);
  } finally {
    instance.unmount();
  }
});

test("reindexa ao digitar @ e vê arquivo criado depois do mount", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-reindex-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    writeFileSync(join(cwd, "novo.md"), "x", "utf8");
    instance.stdin.write("leia @nov");
    await waitFor(() => instance.lastFrame()?.includes("@novo.md") === true);
  } finally {
    instance.unmount();
  }
});

test("!cmd roda pelo shell runner e não vira turno", async () => {
  const calls: string[] = [];
  const shell = {
    enabled: true,
    run: async (command: string) => {
      calls.push(command);
      return command === "falha"
        ? { output: "erro do shell", isError: true }
        : { output: `saida:${command}`, isError: false };
    },
  };
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" shell={shell} />);
  try {
    instance.stdin.write("!echo oi");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("saida:echo oi") === true);
    expect(calls).toEqual(["echo oi"]);
    expect(session.sent).toEqual([]);

    instance.stdin.write("!falha");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro do shell") === true);
  } finally {
    instance.unmount();
  }
});

test("ctrl+x c limpa o contexto e ctrl+x t alterna o tema persistido", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-keys-"));
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("\u0018");
    instance.stdin.write("c");
    await waitFor(() => instance.lastFrame()?.includes("contexto limpo") === true);
    expect(session.cleared).toBe(1);

    instance.stdin.write("\u0018");
    instance.stdin.write("t");
    await waitFor(() => instance.lastFrame()?.includes("tema: light") === true);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { theme?: string };
    expect(config.theme).toBe("light");
  } finally {
    instance.unmount();
  }
});

test("/model persiste o último modelo em .astro/tui.json", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-model-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { lastModel?: string };
    expect(config.lastModel).toBe("p/m2");
  } finally {
    instance.unmount();
  }
});

test("mostra deltas e substitui pela resposta final", async () => {
  class Streamer extends FakeSession {
    override async send(prompt: string, signal?: AbortSignal, onToken?: (text: string) => void): Promise<TurnResult> {
      onToken?.("par");
      await new Promise((resolve) => setTimeout(resolve, 40));
      onToken?.("cial");
      await new Promise((resolve) => setTimeout(resolve, 60));
      return super.send(prompt, signal);
    }
  }
  const instance = render(<TuiApp session={new Streamer()} cwd="/tmp/astro" />);
  try {
    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("parcial") === true);
    await waitFor(() => instance.lastFrame()?.includes("eco:olá") === true);
    expect(instance.lastFrame()).not.toContain("parcial");
  } finally {
    instance.unmount();
  }
});