import { describe, expect, test } from "bun:test";
import { KEYBINDS, LEADER, runKeybind, type KeybindContext } from "../src/tui/keybinds";
import type { SessionSummary } from "../src/chat/store";
import type { Entry } from "../src/tui/commands";

const summary: SessionSummary = {
  path: "/tmp/a.json", id: "abc", startedAt: "2026-10-01T10:00:00.000Z",
  model: "p/m1", turns: 2, costUsd: 0.001,
};

function setup(overrides: Partial<KeybindContext> = {}) {
  const entries: Entry[] = [];
  const calls = { cleared: 0, finished: 0, themes: [] as string[] };
  const context: KeybindContext = {
    session: { clear: () => { calls.cleared++; }, listModels: () => ["p/m1", "p/m2"] },
    theme: "dark",
    addEntries: (added) => { entries.push(...added); },
    setTheme: (theme) => { calls.themes.push(theme); },
    finish: () => { calls.finished++; },
    ...overrides,
  };
  return { context, entries, calls };
}

describe("keybindings da TUI (T2, #197)", () => {
  test("leader expõe sete ações; desconhecida não age", () => {
    expect(LEADER).toBe("ctrl+x");
    for (const key of ["c", "e", "q", "m", "n", "l", "t"]) expect(KEYBINDS[`${LEADER} ${key}`]).toBeDefined();
    const { context, entries } = setup();
    expect(runKeybind("ctrl+x z", context)).toBe(false);
    expect(entries).toEqual([]);
  });

  test("c/n limpam o contexto", () => {
    for (const key of ["c", "n"]) {
      const { context, entries, calls } = setup();
      expect(runKeybind(`ctrl+x ${key}`, context)).toBe(true);
      expect(calls.cleared).toBe(1);
      expect(entries.at(-1)).toEqual({ kind: "info", text: "contexto limpo" });
    }
  });

  test("q encerra, m lista modelos, l lista sessões e t alterna o tema", () => {
    const quit = setup();
    runKeybind("ctrl+x q", quit.context);
    expect(quit.calls.finished).toBe(1);
    const light = setup({ theme: "light" });
    runKeybind("ctrl+x t", light.context);
    expect(light.calls.themes).toEqual(["dark"]);
    expect(light.entries.at(-1)?.text).toBe("tema: dark");
    const models = setup();
    runKeybind("ctrl+x m", models.context);
    expect(models.entries.at(-1)?.text).toBe("p/m1\np/m2");
    const sessions = setup({ store: { list: () => [summary] } });
    runKeybind("ctrl+x l", sessions.context);
    expect(sessions.entries.at(-1)?.text).toContain("abc");
    const noStore = setup();
    runKeybind("ctrl+x l", noStore.context);
    expect(noStore.entries.at(-1)?.text).toBe("sem persistência configurada");
  });

  test("erro de keybind é redigido", () => {
    const { context, entries } = setup({ store: { list: () => { throw new Error("token=segredo123"); } } });
    expect(runKeybind("ctrl+x l", context)).toBe(true);
    expect(entries.at(-1)?.text).toBe("erro: token=[REDACTED]");
  });
});
