/** Ponte de aprovação para a TUI: pergunta vira linha da interface, resposta vem do Enter. */
import type { SwapApprover, SwapRequest } from "../approval";
import type { BudgetDecider, BudgetStatus } from "../budget";
import { budgetChoice, budgetPrompt, isYes, swapPrompt } from "../chat/approvers";

export interface ApprovalQuestion {
  text: string;
  resolve(answer: string): void;
}

export interface ApprovalBridge {
  approveSwap: SwapApprover;
  onBudgetExceeded: BudgetDecider;
  /** Registra o ouvinte da pergunta pendente (chamado com undefined ao responder). */
  subscribe(listener: (question: ApprovalQuestion | undefined) => void): void;
  current(): ApprovalQuestion | undefined;
  /** Entrega a resposta digitada; sem pergunta pendente é no-op. */
  answer(text: string): void;
}

export function createApprovalBridge(): ApprovalBridge {
  let pending: ApprovalQuestion | undefined;
  let listener: ((question: ApprovalQuestion | undefined) => void) | undefined;

  const ask = (text: string): Promise<string> => new Promise((resolve) => {
    pending = {
      text,
      resolve: (answer: string) => {
        pending = undefined;
        listener?.(undefined);
        resolve(answer);
      },
    };
    listener?.(pending);
  });

  return {
    approveSwap: async (request: SwapRequest) => isYes(await ask(swapPrompt(request))),
    onBudgetExceeded: async (status: BudgetStatus) => budgetChoice(await ask(budgetPrompt(status))),
    subscribe: (fn) => {
      listener = fn;
      fn(pending);
    },
    current: () => pending,
    answer: (text) => pending?.resolve(text),
  };
}
