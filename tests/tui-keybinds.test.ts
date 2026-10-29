import { describe, expect, test } from "bun:test";
import { KEYBINDS, LEADER, runKeybind, type KeybindContext } from "../src/tui/keybinds";
import type { SessionSummary } from "../src/chat/store";
import type { Entry } from "../src/tui/commands";

function makeContext(overrides: Partial<KeybindContext> = {}) {
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

const summary: SessionSummary = {
  path: "/tmp/sessions/a.json", id: "abc", startedAt: "2026-10-01T10:00:00.000Z",
  model: "p/m1", turns: 2, costUsd: 0.001,
};

describe("keybindings da TUI (T2, #197)", () => {
  test("leader ctrl+x expõe as sete ações", () => {
    expect(LEADER).toBe("ctrl+x");
    for (const key of ["c", "e", "q", "m", "n", "l", "t"]) {
      expect(KEYBINDS[`${LEADER} ${key}`]).toBeDefined();
    }
  });

  test("ctrl+x c e ctrl+x n limpam o contexto", () => {
    for (const key of ["c", "n"]) {
      const { context, entries, calls } = makeContext();
      expect(runKeybind(`ctrl+x ${key}`, context)).toBe(true);
      expect(calls.cleared).toBe(1);
      expect(entries.at(-1)).toEqual({ kind: "info", text: "contexto limpo" });
    }
  });

  test("ctrl+x t alterna o tema e informa o novo valor", () => {
    const light = makeContext({ theme: "light" });
    runKeybind("ctrl+x t", light.context);
    expect(light.calls.themes).toEqual(["dark"]);
    expect(light.entries.at(-1)?.text).toBe("tema: dark");

    const dark = makeContext({ theme: "dark" });
    runKeybind("ctrl+x t", dark.context);
    expect(dark.calls.themes).toEqual(["light"]);
    expect(dark.entries.at(-1)?.text).toBe("tema: light");
  });

  test("ctrl+x q encerra e ctrl+x m lista modelos", () => {
    const quit = makeContext();
    runKeybind("ctrl+x q", quit.context);
    expect(quit.calls.finished).toBe(1);

    const models = makeContext();
    runKeybind("ctrl+x m", models.context);
    expect(models.entries.at(-1)?.text).toBe("p/m1\np/m2");
  });

  test("ctrl+x l lista sessões; sem store avisa", () => {
    const withStore = makeContext({ store: { list: () => [summary] } });
    runKeybind("ctrl+x l", withStore.context);
    expect(withStore.entries.at(-1)?.text).toContain("abc");

    const withoutStore = makeContext();
    runKeybind("ctrl+x l", withoutStore.context);
    expect(withoutStore.entries.at(-1)?.text).toBe("sem persistência configurada");
  });

  test("combinação desconhecida não age", () => {
    const { context, entries, calls } = makeContext();
    expect(runKeybind("ctrl+x z", context)).toBe(false);
    expect(entries).toEqual([]);
    expect(calls.cleared).toBe(0);
  });
});
