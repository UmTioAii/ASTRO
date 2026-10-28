/** Interactive deciders for chat (TTY): same readline as the REPL, no extra TTY. */
import type { SwapApprover } from "../approval";
import type { BudgetDecider } from "../budget";
import type { ReplIO } from "./repl";

function isYes(answer: string | null): boolean {
  return answer !== null && /^(s|sim|y|yes)$/i.test(answer.trim());
}

function budgetChoice(answer: string | null): "continue_same" | "lower_effort" | "stop" {
  const choice = (answer ?? "").trim().toLowerCase();
  if (choice === "c" || choice === "continuar" || choice === "continue") return "continue_same";
  if (choice === "l" || choice === "baixar" || choice === "lower") return "lower_effort";
  return "stop";
}

export function chatApprovers(
  io: ReplIO,
  interactive: boolean,
): { approveSwap?: SwapApprover; onBudgetExceeded?: BudgetDecider } {
  if (!interactive) return {};
  const ask = (prompt: string): Promise<string | null> => (io.readFresh ?? io.read).call(io, prompt);
  return {
    approveSwap: async (request) => {
      const from = `${request.from.provider}/${request.from.model ?? "?"}`;
      const to = `${request.to.provider}/${request.to.model ?? "?"}`;
      const cost = request.costDeltaUsd === undefined || request.costDeltaUsd === null
        ? ""
        : `; custo delta US$${request.costDeltaUsd.toFixed(2)}/1M`;
      return isYes(await ask(`troca ${from} -> ${to} (${request.reason}${cost}). aprovar? [s/N] `));
    },
    onBudgetExceeded: async (status) => {
      const limit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
      const answer = await ask(`budget esgotado (${status.estimate} / ${limit}). [c] continuar, [l] baixar, [p] parar: `);
      return budgetChoice(answer);
    },
  };
}
