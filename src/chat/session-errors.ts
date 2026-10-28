/** Erros que encerram a sessão de chat de forma definitiva (I-08/I-17/I-19). */
import { SwapDeniedError } from "../approval";
import { BudgetExceededError } from "../budget";

/** O app reembrulha o erro: caminha a cadeia de `cause` (até 5 níveis). */
export function isFatalSessionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof BudgetExceededError || current instanceof SwapDeniedError) return true;
    current = current.cause;
  }
  return false;
}
