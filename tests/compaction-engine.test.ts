import { beforeEach, describe, expect, test } from "bun:test";
import { registerTokenizer, unregisterTokenizer } from "../src/tokens";
import type { ChatMessage } from "../src/provider/types";
import {
  RECENT_TOKENS,
  applyReduction,
  compactSession,
  recentSliceStart,
  reserveTokens,
  shouldCompact,
} from "../src/compaction/engine";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const text = (chars: number): string => "x".repeat(chars);

beforeEach(() => unregisterTokenizer("native"));

describe("gatilho e reserva da janela (S-17, CMP-1)", () => {
  test("buffer ausente/null usa max(15% da janela, 16.000)", () => {
    expect(reserveTokens(200_000, null)).toBe(30_000);
    expect(reserveTokens(100_000, undefined)).toBe(16_000);
    expect(reserveTokens(100_000, null)).toBe(16_000);
  });

  test("buffer explícito substitui o default e é ignorado quando >= janela", () => {
    expect(reserveTokens(100_000, 8_000)).toBe(8_000);
    expect(reserveTokens(32_000, 1_000)).toBe(1_000);
    expect(reserveTokens(100_000, 120_000)).toBe(16_000);
  });

  test("shouldCompact compara a estimativa com window - reserve", () => {
    // janela 1.000, buffer 100 → reserva 100; limiar 900 tokens = 3.600 chars.
    expect(shouldCompact([user(text(3_500))], 1_000, 100)).toBe(false);
    expect(shouldCompact([user(text(3_600))], 1_000, 100)).toBe(true);
  });

  test("shouldCompact usa o tokenizer nativo do provider quando existe", () => {
    registerTokenizer("native", (value) => value.length, "chars");
    // identidade: 901 chars = 901 tokens > 900
    expect(shouldCompact([user(text(901))], 1_000, 100, { provider: "native" })).toBe(true);
    expect(shouldCompact([user(text(900))], 1_000, 100, { provider: "native" })).toBe(false);
  });
});

describe("parte recente (S-17, CMP-2)", () => {
  test("corta no início de mensagem de usuário e respeita o orçamento de 15.000 tokens", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      user(text(40)), // 10 tokens
      assistant(text(40)),
      user(text(40)),
      assistant(text(40)),
    ];
    // orçamento 20 tokens: assistant(40) + user(40) = 20; o anterior estoura.
    expect(recentSliceStart(messages, 20)).toBe(3);
    expect(RECENT_TOKENS).toBe(15_000);
  });

  test("nunca começa no meio de um par tool call/result", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      user(text(40)),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool", content: text(40), toolCallId: "c1" },
    ];
    // Ao cair no tool result, recua até a mensagem de usuário anterior.
    expect(recentSliceStart(messages, 5)).toBe(1);
  });

  test("sem mensagem de usuário, mantém ao menos a última mensagem", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      assistant(text(40)),
      assistant(text(40)),
    ];
    expect(recentSliceStart(messages, 1)).toBe(2);
  });
});

describe("níveis de redução (S-17, CMP-5)", () => {
  const tool = (chars: number): ChatMessage => ({ role: "tool", content: text(chars), toolCallId: "c1" });
  const older: ChatMessage[] = [user(text(100)), assistant(text(100)), tool(10_000), user(text(100))];

  test("nível 1 mantém o histórico completo", () => {
    expect(applyReduction(older, 1)).toEqual({ level: 1, messages: older });
  });

  test("nível 2 clipa saída de tool em 2.000 head + 2.000 tail", () => {
    const reduced = applyReduction(older, 2);
    const clipped = reduced.messages.find((message) => message.role === "tool")!;
    expect(reduced.level).toBe(2);
    expect(clipped.content).toHaveLength(4_000 + "\n[... truncado ...]\n".length);
    expect(clipped.content).toContain("truncado");
    expect(reduced.messages[0]).toEqual(older[0]!);
  });

  test("nível 3 remove saídas de tool e clipa entradas", () => {
    const reduced = applyReduction(older, 3);
    expect(reduced.messages.some((message) => message.role === "tool")).toBe(false);
    expect(reduced.messages.find((message) => message.role === "user")!.content.length).toBeLessThanOrEqual(4_000);
  });

  test("nível 4 mantém só texto de usuário, clipado", () => {
    const reduced = applyReduction(older, 4);
    expect(reduced.messages.every((message) => message.role === "user")).toBe(true);
  });

  test("nível 5 omite o histórico antigo", () => {
    expect(applyReduction(older, 5)).toEqual({ level: 5, messages: [] });
  });
});

describe("compactSession (S-17, CMP-3/CMP-4)", () => {
  test("substitui o antigo por artefato + recente, preserva system e não chama tools", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS-PROMPT" },
      user("tarefa antiga"),
      assistant("resposta antiga"),
      user("tarefa atual"),
      assistant("próximo passo"),
    ];
    const seen: ChatMessage[][] = [];
    const result = await compactSession({
      run: "r1",
      messages,
      window: 1_000,
      buffer: 900,
      recentBudget: 8,
      summarize: async (input) => {
        seen.push(input);
        return "resumo";
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.role).toBe("system");
    expect(seen[0]![0]!.content).toContain("Resuma");
    expect(result.messages[0]).toEqual({ role: "system", content: "SYS-PROMPT" });
    expect(result.messages[1]!.content).toContain("CompactionArtifactV1");
    expect(result.messages[1]!.content).toContain("Active: tarefa atual");
    expect(result.messages.slice(2)).toEqual(messages.slice(3));
    expect(result.artifact.importantContext).toBe("resumo");
    expect(result.originalTokens).toBeGreaterThan(result.returnedTokens);
  });

  test("escala a redução quando o histórico antigo não cabe no orçamento", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      user(text(40)),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool", content: text(20_000), toolCallId: "c1" },
      user("recente"),
    ];
    const seen: ChatMessage[][] = [];
    const result = await compactSession({
      run: "r1",
      messages,
      window: 1_000,
      buffer: 900,
      recentBudget: 10,
      summarize: async (input) => {
        seen.push(input);
        return "s";
      },
    });
    expect(result.reduction).toBeGreaterThan(1);
    expect(seen[0]!.some((message) => message.role === "tool" && message.content.length > 5_000)).toBe(false);
  });

  test("nível 5 omite o antigo sem chamar o resumidor", async () => {
    const older = Array.from({ length: 10 }, () => user(text(4_000)));
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }, ...older, user("recente")];
    let calls = 0;
    const result = await compactSession({
      run: "r1",
      messages,
      window: 1_000,
      buffer: 900,
      recentBudget: 10,
      summarize: async () => {
        calls++;
        return "s";
      },
    });
    expect(result.reduction).toBe(5);
    expect(calls).toBe(0);
    expect(result.artifact.importantContext).toContain("omitid");
  });
});
