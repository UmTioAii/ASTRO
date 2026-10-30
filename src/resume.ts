/**
 * Reconstrução da árvore de agentes (F-22, I-19): o ledger é a única fonte —
 * audit nunca é lido. Lacuna ou árvore quebrada vira `replay_incomplete`.
 */
import type { Ledger, LedgerAgentEntry, RunState } from "./ledger";
import { assertAccountAvailable, accountRefOf, findAgentLock } from "./agent-lock";

/** Replay incompleto: árvore quebrada ou evento ausente (nunca resume parcial). */
export class ReplayIncompleteError extends Error {
  readonly code = "replay_incomplete";
  constructor(message: string) {
    super(message);
    this.name = "ReplayIncompleteError";
  }
}

export interface AgentNode {
  agent_id: string;
  parent_agent_id?: string;
  session_id: string;
  need?: string;
  model?: string;
  provider?: string;
  credentialRef?: string;
  profile?: string;
  createdSeq: number;
  destroyedSeq?: number;
  reason?: string;
}

export interface AgentTree {
  run: string;
  nodes: AgentNode[];
  roots: string[];
  active: AgentNode | undefined;
}

export interface ResumePlan {
  run: string;
  state: RunState;
  tree: AgentTree;
  agent: AgentNode;
}

function eventsOfRun(ledger: Ledger, run: string): LedgerAgentEntry[] {
  const events = ledger.readAllEntries().filter((e): e is LedgerAgentEntry => e.kind === "agent" && e.run === run);
  if (events.some((e) => typeof e.seq !== "number")) {
    throw new ReplayIncompleteError(`run "${run}" com evento "agent" sem seq; replay incompleto`);
  }
  return events.sort((a, b) => a.seq - b.seq);
}
/** Reconstrói a árvore de agentes de um run a partir dos eventos `agent`. */
export function rebuildAgentTree(ledger: Ledger, run: string): AgentTree {
  const events = eventsOfRun(ledger, run);
  if (events.length === 0) throw new ReplayIncompleteError(`run "${run}" sem eventos "agent"; replay incompleto`);

  const nodes = new Map<string, AgentNode>();
  for (const event of events) {
    if (event.session_id !== run) {
      throw new ReplayIncompleteError(`evento "agent" do run "${run}" com session_id "${event.session_id}"; replay incompleto`);
    }
    if (event.event === "created") {
      const existing = nodes.get(event.agent_id);
      if (existing !== undefined) {
        if (existing.destroyedSeq === undefined) throw new ReplayIncompleteError(`agente "${event.agent_id}" criado duas vezes; replay incompleto`);
        // Reabertura (handoff de volta): mantém raiz/pai original.
        delete existing.destroyedSeq;
        delete existing.reason;
        continue;
      }
      if (event.parent_agent_id !== undefined && !nodes.has(event.parent_agent_id)) {
        throw new ReplayIncompleteError(`agente "${event.agent_id}" referencia pai "${event.parent_agent_id}" inexistente; replay incompleto`);
      }
      nodes.set(event.agent_id, {
        agent_id: event.agent_id,
        ...(event.parent_agent_id === undefined ? {} : { parent_agent_id: event.parent_agent_id }),
        session_id: event.session_id,
        ...(event.need === undefined ? {} : { need: event.need }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.provider === undefined ? {} : { provider: event.provider }),
        ...(event.credentialRef === undefined ? {} : { credentialRef: event.credentialRef }),
        ...(event.profile === undefined ? {} : { profile: event.profile }),
        createdSeq: event.seq,
      });
      continue;
    }
    const node = nodes.get(event.agent_id);
    if (node === undefined) throw new ReplayIncompleteError(`agente "${event.agent_id}" destruído sem created; replay incompleto`);
    if (event.event === "identity") {
      if (event.model !== undefined) node.model = event.model;
      if (event.provider !== undefined) {
        node.provider = event.provider;
        node.credentialRef = event.credentialRef;
      }
      if (event.profile !== undefined) node.profile = event.profile;
      continue;
    }
    if (node.destroyedSeq !== undefined) throw new ReplayIncompleteError(`agente "${event.agent_id}" destruído duas vezes; replay incompleto`);
    node.destroyedSeq = event.seq;
    if (event.reason !== undefined) node.reason = event.reason;
  }

  const ordered = [...nodes.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  const roots = ordered.filter((n) => n.parent_agent_id === undefined).map((n) => n.agent_id);
  if (roots.length !== 1) throw new ReplayIncompleteError(`run "${run}" com ${roots.length} raízes; replay incompleto`);
  const active = ordered.filter((n) => n.destroyedSeq === undefined);
  if (active.length > 1) throw new ReplayIncompleteError(`run "${run}" com ${active.length} agentes ativos; replay incompleto`);
  return { run, nodes: ordered, roots, active: active[0] };
}

/** Plano determinístico de retomada: último `run_state` + agente a retomar, sem recalcular escolhas. */
export function planResume(ledger: Ledger, run: string): ResumePlan {
  const last = ledger.lastState(run);
  if (last?.state === "completed") throw new ReplayIncompleteError(`run "${run}" já concluído; nada a retomar`);
  const tree = rebuildAgentTree(ledger, run);
  // Run interrompido por erro/cancelamento já liberou o lock e fechou o agente.
  // O alvo é o agente registrado no `run_state` (quem foi interrompido), não o
  // último criado: em handoff de volta o nó reaberto mantém o createdSeq
  // original. Sem `run_state`, vale o último evento `agent` do run (reapertura
  // conta), que é onde o crash parou.
  const stateAgent = last?.agent === undefined
    ? undefined
    : tree.nodes.find((node) => node.agent_id === last.agent);
  const lastEvent = eventsOfRun(ledger, run).at(-1);
  const lastTouched = lastEvent === undefined
    ? undefined
    : tree.nodes.find((node) => node.agent_id === lastEvent.agent_id);
  const agent = tree.active ?? stateAgent ?? lastTouched;
  if (agent === undefined) throw new ReplayIncompleteError(`run "${run}" sem agente para retomar; replay incompleto`);
  return { run, state: last?.state ?? "interrupted", tree, agent };
}

/**
 * Compara a identidade gravada do agente com a config atual e recusa troca
 * silenciosa de provider/credencial (I-08). Ledger antigo (sem provider) é
 * aceito uma vez e recebe um evento `identity` com a identidade atual.
 */
export function assertResumeIdentity(
  agent: AgentNode,
  expected: { provider: string; credentialRef?: string },
  ledger: Ledger,
  run: string,
): void {
  const recordedProvider = agent.provider;
  if (recordedProvider !== undefined && recordedProvider !== expected.provider) {
    throw new ReplayIncompleteError(
      `provider do agente "${agent.agent_id}" mudou (gravado "${recordedProvider}", config "${expected.provider}"); replay incompleto`,
    );
  }
  const recordedCredential = agent.credentialRef;
  if (recordedProvider !== undefined) {
    if (recordedCredential !== expected.credentialRef) {
      const from = recordedCredential ?? "sem credencial";
      const to = expected.credentialRef ?? "sem credencial";
      throw new ReplayIncompleteError(
        `credencial do agente "${agent.agent_id}" mudou (gravado "${from}", config "${to}"); replay incompleto`,
      );
    }
    return;
  }

  // O agente legado não gravou provider. Se o run já liberou o lock (erro ou
  // crash recuperado), não há evento a gravar: a recriação adquire a conta
  // pelo caminho normal. Ativo, a conta de destino não pode estar cativa (A4).
  if (findAgentLock(ledger, run, agent.agent_id) === undefined) {
    agent.provider = expected.provider;
    agent.credentialRef = expected.credentialRef;
    return;
  }
  assertAccountAvailable(ledger, accountRefOf(expected), { run, agent_id: agent.agent_id });
  ledger.recordAgentIdentity({
    run,
    agent_id: agent.agent_id,
    session_id: run,
    provider: expected.provider,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(expected.credentialRef === undefined ? {} : { credentialRef: expected.credentialRef }),
    ...(agent.profile === undefined ? {} : { profile: agent.profile }),
  });
  agent.provider = expected.provider;
  agent.credentialRef = expected.credentialRef;
}
