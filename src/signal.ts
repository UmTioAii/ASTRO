/**
 * Cancelamento do run por sinal do SO (I-19): o primeiro SIGINT/SIGTERM vira
 * `AbortSignal` cooperativo, então tools em voo e o provider param no próximo
 * ponto seguro. O segundo sinal encerra na hora, sem esperar o run terminar.
 */

/** Superfície mínima de `process` usada aqui (injetável nos testes). */
export interface SignalTarget {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface Cancellation {
  signal: AbortSignal;
  /** Remove os listeners; chamar no `finally` do comando. */
  dispose(): void;
}

export function installCancellation(
  opts: { target?: SignalTarget; onForce?: () => void; signals?: readonly string[] } = {},
): Cancellation {
  const target = opts.target ?? process;
  const signals = opts.signals ?? ["SIGINT", "SIGTERM"];
  const force = opts.onForce ?? (() => process.exit(130));
  const controller = new AbortController();
  let received = false;

  const onSignal = (): void => {
    if (received) {
      force();
      return;
    }
    received = true;
    controller.abort(new DOMException("cancelado pelo usuário", "AbortError"));
  };

  for (const signal of signals) target.on(signal, onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) target.off(signal, onSignal);
    },
  };
}
