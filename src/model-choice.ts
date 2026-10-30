/**
 * Stub do pipeline de candidatos (RED): tipos e assinaturas, sem implementação.
 */
import type { AstroConfig, BudgetConfig } from "./config";
import type { Ledger } from "./ledger";
import type { QuotaLimit } from "./quota";
import type { Registry } from "./registry";

export interface ModelCandidate {
  model: string;
  profile?: string;
  tags: string[];
  efficiency: number;
  estimated_cost_max_usd: number | null;
}

export interface CandidateQuery {
  need: string;
  requires?: string[];
  estimatedInputTokens?: number;
}

export interface CandidateDeps {
  config: AstroConfig;
  registry: Registry;
  ledger: Ledger;
  quotaLimits?: Record<string, QuotaLimit>;
  budget?: BudgetConfig;
  activeAccounts?: ReadonlySet<string>;
  cooldown?: (candidate: { model: string; profile?: string; provider: string }) => boolean;
  now?: () => number;
}

export interface CandidateSnapshot {
  candidates: ModelCandidate[];
  snapshot_id: string;
  expires_at: string;
  ranking: "cost" | "no_price";
}

export interface ModelChoice {
  candidate: ModelCandidate;
  reason: string;
}

export class ModelChoiceError extends Error {
  readonly code: string;
  readonly candidates?: ModelCandidate[];

  constructor(code: string, message: string, candidates?: ModelCandidate[]) {
    super(message);
    this.name = "ModelChoiceError";
    this.code = code;
    if (candidates !== undefined) this.candidates = candidates;
  }
}

export class CandidateSetChangedError extends ModelChoiceError {
  readonly snapshot: CandidateSnapshot;

  constructor(message: string, snapshot: CandidateSnapshot) {
    super("candidate_set_changed", message, snapshot.candidates);
    this.name = "CandidateSetChangedError";
    this.snapshot = snapshot;
  }
}

/** Stub: nenhum snapshot é criado no RED. */
export function markModelHealthChanged(): void {}

export function modelHealthRevision(): number {
  return 0;
}

export function resetCandidateSnapshots(): void {}

export function listModelCandidates(_query: CandidateQuery, _deps: CandidateDeps): CandidateSnapshot {
  throw new Error("não implementado");
}

export function resolveModelChoice(
  _snapshotId: string,
  _model: string | undefined,
  _deps: CandidateDeps,
): ModelChoice {
  throw new Error("não implementado");
}
