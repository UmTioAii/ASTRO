/** Interactive deciders for chat (TTY): same readline as the REPL, no extra TTY. */
import type { SwapApprover } from "../approval";
import type { BudgetDecider } from "../budget";
import type { ReplIO } from "./repl";

function isYes(answer: string | null): boolean {
  return answer !== null && /^(s|sim|y|yes)$/i.test(answer.trim());
}

export function chatApprovers(
  io: ReplIO,
  interactive: boolean,
): { approveSwap?: SwapApprover; onBudgetExceeded?: BudgetDecider } {
  if (!interactive) return {};
  return {
    approveSwap: async (request) => {
      const from = `${request.from.provider}/${request.from.model ?? "?"}`;
      const to = `${request.to.provider}/${request.to.model ?? "?"}`;
      const cost = request.costDeltaUsd === undefined || request.costDeltaUsd === null
        ? ""
        : `; custo delta US$${request.costDeltaUsd.toFixed(2)}/1M`;
      return isYes(await io.read(`troca ${from} -> ${to} (${request.reason}${cost}). aprovar? [s/N] `));
    },
    onBudgetExceeded: async (status) => {
      const limit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
      const answer = await io.read(`budget esgotado (${status.estimate} / ${limit}). [c] continuar, [l] baixar, [p] parar: `);
      const choice = (answer ?? "").trim().toLowerCase();
      return choice.startsWith("c") ? "continue_same" : choice.startsWith("l") ? "lower_effort" : "stop";
    },
  };
}
