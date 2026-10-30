/**
 * Lock de conta por agente ativo (A4, PS-5, ADR-0009): a exclusividade é
 * derivada dos eventos `agent` do ledger — `created` adquire, `destroyed`
 * libera, `identity` atualiza a conta. Sem arquivo de lock separado.
 */
import type { Auditor } from "./audit";
import type { Ledger } from "./ledger";

/** Conta presa por um agente ativo, reconstruída do ledger. */
export interface AgentLock {
  run: string;
  agent_id: string;
  session_id: string;
  /** `credentialRef` ou `provider:<nome>` para provider sem credencial (I-03). */
  accountRef: string;
  provider?: string;
  model?: string;
  profile?: string;
  seq: number;
}

/** Segunda aquisição da mesma conta: falha explícita, sem valor de segredo. */
export class AccountLockedError extends Error {
  readonly code = "account_locked";
  readonly accountRef: string;
  readonly holder: AgentLock;

  constructor(accountRef: string, holder: AgentLock) {
    super(
      `conta "${accountRef}" já está em uso pelo agente "${holder.agent_id}" no run "${holder.run}"`,
    );
    this.name = "AccountLockedError";
    this.accountRef = accountRef;
    this.holder = holder;
  }
}

export interface AcquireAgentLockOptions {
  run: string;
  agent_id: string;
  session_id: string;
  provider?: string;
  model?: string;
  credentialRef?: string;
  profile?: string;
  parent_agent_id?: string;
}

export interface ReleaseAgentLockOptions {
  run: string;
  agent_id: string;
  session_id?: string;
  reason: string;
}

/** Identidade da conta: credencial nomeada ou o provider quando não há chave. */
export function accountRefOf(identity: { credentialRef?: string; provider?: string }): string {
  throw new Error("não implementado");
}

/** Contas presas neste momento, na ordem em que foram adquiridas. */
export function activeLocks(_ledger: Ledger): AgentLock[] {
  throw new Error("não implementado");
}

/** Adquire a conta do agente; falha se outro agente ativo já a detém. */
export function acquireAgentLock(
  _ledger: Ledger,
  _audit: Auditor,
  _opts: AcquireAgentLockOptions,
): AgentLock {
  throw new Error("não implementado");
}

/** Libera a conta do agente; `false` quando o agente já não está ativo. */
export function releaseAgentLock(
  _ledger: Ledger,
  _audit: Auditor,
  _opts: ReleaseAgentLockOptions,
): boolean {
  throw new Error("não implementado");
}

/** Recuperação de crash (A4, §11.5): destrói órfãos do run e libera as contas. */
export function recoverCrashedAgents(_ledger: Ledger, _audit: Auditor, _run: string): AgentLock[] {
  throw new Error("não implementado");
}
