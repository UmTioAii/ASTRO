import { describe, expect, test } from "bun:test";
import { createApprovalBridge } from "../src/tui/approvals";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";

const swap: SwapRequest = {
  run: "r1", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" },
  reason: "fallback", costDeltaUsd: 1,
};
const budget = { limitUsd: 1, estimate: "US$ 2.000000" } as BudgetStatus;

describe("ponte de aprovação da TUI (T2, #63)", () => {
  test("swap publica a pergunta e aprova só com s/sim", async () => {
    const bridge = createApprovalBridge();
    const seen: Array<string | undefined> = [];
    bridge.subscribe((question) => seen.push(question?.text));
    const decision = bridge.approveSwap(swap);
    expect(seen.at(-1)).toContain("aprovar? [s/N]");
    expect(bridge.current()?.text).toContain("a/m1 -> b/m2");
    bridge.answer("s");
    expect(await decision).toBe(true);
    expect(bridge.current()).toBeUndefined();
    expect(seen.at(-1)).toBeUndefined();
  });

  test("resposta vazia nega; budget mapeia tokens exatos", async () => {
    const bridge = createApprovalBridge();
    const denied = bridge.approveSwap(swap);
    bridge.answer("");
    expect(await denied).toBe(false);

    const chose = createApprovalBridge();
    const lower = chose.onBudgetExceeded(budget);
    chose.answer("l");
    expect(await lower).toBe("lower_effort");

    const stopping = createApprovalBridge();
    const stop = stopping.onBudgetExceeded(budget);
    stopping.answer("p");
    expect(await stop).toBe("stop");

    const odd = createApprovalBridge();
    const cancelled = odd.onBudgetExceeded(budget);
    odd.answer("cancelar");
    expect(await cancelled).toBe("stop");
  });
});
