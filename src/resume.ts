/**
 * Reconstrução da árvore de agentes (F-22, I-19): o ledger é a única fonte —
 * audit nunca é lido. Lacuna ou árvore quebrada vira `replay_incomplete`.
 */
import type { Ledger, LedgerAgentEntry, RunState } from "./ledger";

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
        ...(event.profile === undefined ? {} : { profile: event.profile }),
        createdSeq: event.seq,
      });
      continue;
    }
    const node = nodes.get(event.agent_id);
    if (node === undefined) throw new ReplayIncompleteError(`agente "${event.agent_id}" destruído sem created; replay incompleto`);
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

/** Plano determinístico de retomada: último `run_state` + agente ativo, sem recalcular escolhas. */
export function planResume(ledger: Ledger, run: string): ResumePlan {
  const state = ledger.lastState(run);
  if (state === undefined) throw new ReplayIncompleteError(`run "${run}" sem run_state; replay incompleto`);
  if (state.state === "completed") throw new ReplayIncompleteError(`run "${run}" já concluído; nada a retomar`);
  const tree = rebuildAgentTree(ledger, run);
  if (tree.active === undefined) throw new ReplayIncompleteError(`run "${run}" sem agente ativo; replay incompleto`);
  return { run, state: state.state, tree, agent: tree.active };
}
