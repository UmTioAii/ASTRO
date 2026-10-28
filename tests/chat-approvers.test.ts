import { describe, expect, test } from "bun:test";
import { chatApprovers } from "../src/chat/approvers";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";
import type { ReplIO } from "../src/chat/repl";

function io(answers: Array<string | null>): ReplIO {
  return { read: async () => answers.shift() ?? null, write: () => {} };
}

const swap: SwapRequest = {
  run: "r1", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" },
  reason: "fallback", costDeltaUsd: 1,
};
const budget = { limitUsd: 1, estimate: "US$ 2.000000" } as BudgetStatus;

describe("decisores interativos do chat", () => {
  test("swap: s/yes aprova; n/EOF nega", async () => {
    const yes = chatApprovers(io(["s"]), true).approveSwap!;
    const no = chatApprovers(io(["n"]), true).approveSwap!;
    const eof = chatApprovers(io([null]), true).approveSwap!;
    expect(await yes(swap)).toBe(true);
    expect(await no(swap)).toBe(false);
    expect(await eof(swap)).toBe(false);
  });
  test("budget: c/l/p mapeiam as três escolhas; outros param", async () => {
    const decider = (answer: string) => chatApprovers(io([answer]), true).onBudgetExceeded!;
    expect(await decider("c")(budget)).toBe("continue_same");
    expect(await decider("l")(budget)).toBe("lower_effort");
    expect(await decider("p")(budget)).toBe("stop");
    expect(await decider("x")(budget)).toBe("stop");
  });
  test("sem TTY não injeta decisores", () => {
    expect(chatApprovers(io([]), false)).toEqual({});
  });
});
