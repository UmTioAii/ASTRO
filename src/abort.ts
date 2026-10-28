/**
 * Cancelamento (F-06, I-19): `signal.aborted` é a fonte de verdade — o abort pode
 * chegar como `AbortError` do fetch ou como a `reason` de `controller.abort(x)`.
 */

/** True quando o erro representa o cancelamento do signal informado. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Lança o erro de cancelamento se o signal já estiver abortado (ponto seguro). */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal === undefined || signal.aborted !== true) return;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : new DOMException("Abortado", "AbortError");
}
