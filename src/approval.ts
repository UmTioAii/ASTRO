/**
 * Gate de aprovação de troca de identidade (F-19, I-08): nenhuma troca de
 * credencial/provider/modelo executa sem decisão explícita. O runtime sempre
 * fornece um approver; sem TTY a decisão é "pending" (para em ponto seguro).
 */

/** Destino/origem de uma troca (sem segredo: credencial é referência por nome). */
export interface SwapTarget {
  provider: string;
  model?: string;
  profile?: string;
  credentialRef?: string;
}

export interface SwapRequest {
  run: string;
  from: SwapTarget;
  to: SwapTarget;
  reason: string;
  /** Delta de custo estimado (US$/1M) entre destino e origem; null quando desconhecido. */
  costDeltaUsd?: number | null;
  /** Capacidades ganhas/perdidas na troca. */
  capabilityDelta?: string[];
}

export type SwapDecision = "approved" | "denied" | "pending";

/** Delta de custo/capacidade entre dois modelos (D-16); null quando falta preço. */
export function swapDelta(
  from?: { price?: { inputPerM: number }; capabilities?: Record<string, boolean> },
  to?: { price?: { inputPerM: number }; capabilities?: Record<string, boolean> },
): { costDeltaUsd: number | null; capabilityDelta: string[] } {
  const costDeltaUsd = from?.price !== undefined && to?.price !== undefined
    ? to.price.inputPerM - from.price.inputPerM
    : null;
  const caps = (m?: { capabilities?: Record<string, boolean> }) =>
    new Set(Object.entries(m?.capabilities ?? {}).filter(([, on]) => on).map(([name]) => name));
  const fromCaps = caps(from);
  const toCaps = caps(to);
  const capabilityDelta = [
    ...[...toCaps].filter((c) => !fromCaps.has(c)).map((c) => `+${c}`),
    ...[...fromCaps].filter((c) => !toCaps.has(c)).map((c) => `-${c}`),
  ];
  return { costDeltaUsd, capabilityDelta };
}

/** Decide uma troca; `false` (ou ausência de approver) bloqueia a execução. */
export type SwapApprover = (request: SwapRequest) => Promise<boolean> | boolean;

/** Troca não aprovada: o run para em ponto seguro (I-19) sem executar o swap. */
export class SwapDeniedError extends Error {
  readonly code = "swap_denied";
  readonly request: SwapRequest;
  readonly decision: SwapDecision;
  constructor(request: SwapRequest, decision: SwapDecision) {
    super(
      `troca de ${request.from.provider}/${request.from.model ?? "?"} para ` +
        `${request.to.provider}/${request.to.model ?? "?"} não aprovada (${decision})`,
    );
    this.name = "SwapDeniedError";
    this.request = request;
    this.decision = decision;
  }
}
