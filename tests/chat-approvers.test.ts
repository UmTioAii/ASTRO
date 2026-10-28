import { describe, expect, test } from "bun:test";
import { chatApprovers } from "../src/chat/approvers";
import type { SwapRequest } from "../src/approval";
import type { BudgetStatus } from "../src/budget";
import type { ReplIO } from "../src/chat/repl";

function io(answers: Array<string | null>): ReplIO {
  return { read: async () => answers.shift() ?? null, write: () => {} };
}

function ioWithFresh(queued: string[], fresh: Array<string | null>) {
  const state = { read: 0, readFresh: 0, queued: [...queued] };
  const fake: ReplIO = {
    read: async () => {
      state.read++;
      return state.queued.shift() ?? null;
    },
    readFresh: async () => {
      state.readFresh++;
      return fresh.shift() ?? null;
    },
    write: () => {},
  };
  return { io: fake, state };
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
  test("budget só aceita tokens exatos; 'cancelar' e instrução param", async () => {
    const decider = (answer: string) => chatApprovers(io([answer]), true).onBudgetExceeded!;
    expect(await decider("cancelar")(budget)).toBe("stop");
    expect(await decider("corrija o bug")(budget)).toBe("stop");
    expect(await decider("")(budget)).toBe("stop");
    expect(await decider("continuar")(budget)).toBe("continue_same");
    expect(await decider("baixar")(budget)).toBe("lower_effort");
  });
  test("decisores leem linha nova e preservam a fila do REPL", async () => {
    const swapIo = ioWithFresh(["corrija o bug"], ["n"]);
    expect(await chatApprovers(swapIo.io, true).approveSwap!(swap)).toBe(false);
    expect(swapIo.state.read).toBe(0);
    expect(swapIo.state.readFresh).toBe(1);
    expect(swapIo.state.queued).toEqual(["corrija o bug"]);

    const budgetIo = ioWithFresh([], ["c"]);
    expect(await chatApprovers(budgetIo.io, true).onBudgetExceeded!(budget)).toBe("continue_same");
    expect(budgetIo.state.readFresh).toBe(1);
  });
});
