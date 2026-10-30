/**
 * Lock de conta por agente ativo (A4, PS-5, ADR-0009): a exclusividade é
 * derivada dos eventos `agent` do ledger — `created` adquire, `destroyed`
 * libera, `identity` atualiza a conta. Sem arquivo de lock separado.
 */
import type { Auditor } from "./audit";
import type { Ledger, LedgerAgentEntry } from "./ledger";
import { redactSecrets } from "./sanitize-external";

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
  if (identity.credentialRef !== undefined && identity.credentialRef.length > 0) {
    return identity.credentialRef;
  }
  return `provider:${identity.provider ?? "unknown"}`;
}

/** Chave de agente: o mesmo nome em runs distintos é outro agente. */
function agentKey(run: string, agentId: string): string {
  return `${run}\u0000${agentId}`;
}

/**
 * Compara com o que foi gravado: o ledger redige run/agent_id (I-03), então a
 * busca normaliza os dois lados antes de casar.
 */
function sameAgent(lock: AgentLock, run: string, agentId: string): boolean {
  return lock.run === redactSecrets(run) && lock.agent_id === redactSecrets(agentId);
}

/** Contas presas neste momento, na ordem em que foram adquiridas. */
export function activeLocks(ledger: Ledger): AgentLock[] {
  const locks = new Map<string, AgentLock>();
  for (const entry of ledger.readAllEntries()) {
    if (entry.kind !== "agent") continue;
    const key = agentKey(entry.session_id, entry.agent_id);
    if (entry.event === "created") {
      locks.set(key, lockFrom(entry));
      continue;
    }
    const lock = locks.get(key);
    if (lock === undefined) continue;
    if (entry.event === "identity") {
      if (entry.provider !== undefined) {
        lock.provider = entry.provider;
        lock.accountRef = accountRefOf(entry);
      }
      if (entry.model !== undefined) lock.model = entry.model;
      if (entry.profile !== undefined) lock.profile = entry.profile;
      continue;
    }
    locks.delete(key);
  }
  return [...locks.values()].sort((a, b) => a.seq - b.seq);
}

function lockFrom(entry: LedgerAgentEntry): AgentLock {
  return {
    run: entry.run,
    agent_id: entry.agent_id,
    session_id: entry.session_id,
    accountRef: accountRefOf(entry),
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.profile === undefined ? {} : { profile: entry.profile }),
    seq: entry.seq,
  };
}

/**
 * Adquire a conta do agente; falha se outro agente ativo já a detém.
 * A checagem e a escrita de `agent.created` são serializadas no arquivo do
 * ledger, então dois processos não adquirem a mesma conta ao mesmo tempo.
 */
export function acquireAgentLock(
  ledger: Ledger,
  audit: Auditor,
  opts: AcquireAgentLockOptions,
): AgentLock {
  return ledger.withFileLock(() => {
    const accountRef = accountRefOf(opts);
    const locks = activeLocks(ledger);
    const self = locks.find((l) => sameAgent(l, opts.run, opts.agent_id));
    if (self !== undefined) return self;
    const holder = locks.find((l) => l.accountRef === accountRef);
    if (holder !== undefined) throw new AccountLockedError(accountRef, holder);

    const entry = ledger.recordAgentCreated({
      run: opts.run,
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      ...(opts.credentialRef === undefined ? {} : { credentialRef: opts.credentialRef }),
      ...(opts.profile === undefined ? {} : { profile: opts.profile }),
      ...(opts.parent_agent_id === undefined ? {} : { parent_agent_id: opts.parent_agent_id }),
    });
    audit.append({
      run: opts.run,
      agent: opts.agent_id,
      tipo: "agent.created",
      payload: {
        agent_id: opts.agent_id,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.provider === undefined ? {} : { provider: opts.provider }),
        ...(opts.credentialRef === undefined ? {} : { credentialRef: opts.credentialRef }),
        ...(opts.parent_agent_id === undefined ? {} : { parent_agent_id: opts.parent_agent_id }),
      },
    });
    audit.append({
      run: opts.run,
      agent: opts.agent_id,
      tipo: "agent.lock.acquired",
      payload: {
        agent_id: opts.agent_id,
        accountRef,
        ...(opts.provider === undefined ? {} : { provider: opts.provider }),
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.profile === undefined ? {} : { profile: opts.profile }),
      },
    });
    return lockFrom(entry);
  });
}

/** Libera a conta do agente; `false` quando o agente já não está ativo. */
export function releaseAgentLock(
  ledger: Ledger,
  audit: Auditor,
  opts: ReleaseAgentLockOptions,
): boolean {
  return ledger.withFileLock(() => {
    const lock = activeLocks(ledger).find((l) => sameAgent(l, opts.run, opts.agent_id));
    if (lock === undefined) return false;
    ledger.recordAgentDestroyed({
      run: opts.run,
      agent_id: opts.agent_id,
      session_id: opts.session_id ?? lock.session_id,
      reason: opts.reason,
    });
    audit.append({
      run: opts.run,
      agent: opts.agent_id,
      tipo: "agent.destroyed",
      payload: { agent_id: opts.agent_id, reason: opts.reason },
    });
    audit.append({
      run: opts.run,
      agent: opts.agent_id,
      tipo: "agent.lock.released",
      payload: { agent_id: opts.agent_id, accountRef: lock.accountRef, reason: opts.reason },
    });
    return true;
  });
}

/** Recuperação de crash (A4, §11.5): destrói órfãos do run e libera as contas. */
export function recoverCrashedAgents(ledger: Ledger, audit: Auditor, run: string): AgentLock[] {
  const orphans = activeLocks(ledger).filter((lock) => lock.run === redactSecrets(run));
  for (const lock of orphans) {
    releaseAgentLock(ledger, audit, {
      run: lock.run,
      agent_id: lock.agent_id,
      session_id: lock.session_id,
      reason: "crash_recovered",
    });
  }
  return orphans;
}
