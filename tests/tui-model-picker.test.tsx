import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession } from "../src/chat/repl";
import type { ModelInfo, ProviderInfo, SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import { TuiApp } from "../src/tui/app";
import { filterModels, modelDetail, orderModels, recordRecent, toggleFavorite, type ModelOption } from "../src/tui/models";
import { loadTuiConfig } from "../src/tui/theme";

class FakeSession implements ChatSession {
  model = "p/m1";
  setModel(ref: string): string {
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1", "p/m2", "p/fast"];
  }
  listModelInfo(): ModelInfo[] {
    return [
      {
        ref: "p/m1", provider: "p", id: "m1", tags: ["writing-code"], context: 8192, status: "active",
        price: { inputPerM: 1, outputPerM: 2, fonte: "test", verificado: true },
      },
      { ref: "p/m2", provider: "p", id: "m2", tags: ["fast"], context: 4096, status: "active" },
      { ref: "p/fast", provider: "p", id: "fast", tags: ["fast"], context: 4096, status: "active" },
    ];
  }
  listProviders(): ProviderInfo[] {
    return [];
  }
  setProvider(name: string): string {
    return `${name}/m1`;
  }
  async send(): Promise<TurnResult> {
    throw new Error("não usado");
  }
  compact(): Promise<string> {
    return Promise.resolve("não usado");
  }
  clear(): void {}
  resume(_snapshot: SessionSnapshot): void {}
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-29T00:00:00.000Z", model: this.model,
      messages: [], turns: 0, tokensIn: 0, tokensOut: 0, costUsd: null,
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

async function openPicker(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("/model");
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Modelos") === true);
}

test("helpers do seletor: filtro, ordem, recente, favorito e detalhe", () => {
  const option = (id: string, tags: string[] = []): ModelOption => ({
    ref: `p/${id}`, provider: "p", id, tags, context: 8192, status: "active",
  });
  const a = option("a", ["writing-code"]);
  const b = option("b");
  const c = option("c");
  expect(filterModels([a, b], "writing").map((item) => item.id)).toEqual(["a"]);
  expect(filterModels([a, b], "P/B").map((item) => item.id)).toEqual(["b"]);
  expect(orderModels([a, b, c], ["p/c"], ["p/b", "p/ghost"]).map((item) => item.id)).toEqual(["c", "b", "a"]);
  expect(recordRecent("p/a", Array.from({ length: 10 }, (_, index) => `p/m${index}`))).toHaveLength(10);
  expect(toggleFavorite("p/a", ["p/a", "p/b"])).toEqual(["p/b"]);
  expect(modelDetail({ ...a, price: { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false } }))
    .toContain("in 1/M");
  expect(modelDetail(b)).toContain("n/d");
});

test("/model abre o seletor, filtra e troca o modelo persistindo o recente", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await openPicker(instance);
    expect(instance.lastFrame()).toContain("p/m1");
    expect(instance.lastFrame()).toContain("contexto 8192");
    expect(instance.lastFrame()).toContain("in 1/M");

    instance.stdin.write("m2");
    await waitFor(() => instance.lastFrame()?.includes("p/m2") === true && instance.lastFrame()?.includes("p/m1") === false);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Modelos") === false);

    expect(session.model).toBe("p/m2");
    expect(loadTuiConfig(cwd)).toMatchObject({ lastModel: "p/m2", recentModels: ["p/m2"] });
  } finally {
    instance.unmount();
  }
});

test("esc fecha o seletor sem trocar o modelo e ctrl+f persiste o favorito", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-esc-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await openPicker(instance);
    instance.stdin.write("\u0006");
    await waitFor(() => loadTuiConfig(cwd).favoriteModels?.includes("p/m1") === true);
    instance.stdin.write("\u001b");
    await waitFor(() => instance.lastFrame()?.includes("Modelos") === false);
    expect(session.model).toBe("p/m1");
    expect(loadTuiConfig(cwd).favoriteModels).toEqual(["p/m1"]);
  } finally {
    instance.unmount();
  }
});

test("busca aceita f no termo", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-search-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await openPicker(instance);
    instance.stdin.write("fast");
    await waitFor(() => instance.lastFrame()?.includes("p/fast") === true && instance.lastFrame()?.includes("p/m1") === false);
    expect(instance.lastFrame()).toContain("buscar: fast");
    expect(loadTuiConfig(cwd).favoriteModels).toBeUndefined();
  } finally {
    instance.unmount();
  }
});

test("tab move e favoritar não troca a seleção", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-keys-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await openPicker(instance);
    instance.stdin.write("\t");
    await waitFor(() => instance.lastFrame()?.includes(">   p/m2") === true);
    instance.stdin.write("\u0006");
    await waitFor(() => loadTuiConfig(cwd).favoriteModels?.includes("p/m2") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Modelos") === false);
    expect(session.model).toBe("p/m2");
  } finally {
    instance.unmount();
  }
});

test("modelo sem metadados mostra contexto n/d em vez de zero", async () => {
  const session = new FakeSession();
  Object.defineProperty(session, "listModelInfo", { value: undefined });
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-bare-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await openPicker(instance);
    expect(instance.lastFrame()).toContain("contexto n/d");
    expect(instance.lastFrame()).toContain("unknown");
  } finally {
    instance.unmount();
  }
});
