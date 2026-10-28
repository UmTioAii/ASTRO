import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseCommand } from "../src/chat/commands";

describe("comandos do chat (T1, #62)", () => {
  test("texto normal vira prompt; vazio é ignorado", () => {
    expect(parseCommand("  olá mundo  ")).toEqual({ kind: "prompt", text: "olá mundo" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });
  test("aliases de saída e ajuda", () => {
    for (const line of ["/exit", "/quit", "/q", "/EXIT"]) expect(parseCommand(line)).toEqual({ kind: "exit" });
    expect(parseCommand("/help")).toEqual({ kind: "help" });

  });
  test("/model sem arg lista; com arg troca; desconhecido nomeia", () => {
    expect(parseCommand("/model")).toEqual({ kind: "model" });
    expect(parseCommand("/model p/m2")).toEqual({ kind: "model", model: "p/m2" });
    expect(parseCommand("/nope a")).toEqual({ kind: "unknown", raw: "nope" });
  });
  test("ajuda lista os quatro comandos", () => {
    for (const command of ["/help", "/model", "/clear", "/exit"]) expect(HELP_TEXT).toContain(command);
  });
});
