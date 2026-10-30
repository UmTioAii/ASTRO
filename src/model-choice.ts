/**
 * Pipeline de candidatos para escolha de modelo (M1–M3, M6–M8, ADR-0011):
 * filtro duro sobre a model pool, ranking por tag/custo e snapshot com TTL de
 * 5 minutos. A escolha é registrada no evento `agent` do ledger (nunca no
 * usage) por quem faz o spawn.
 */
import { createHash } from "node:crypto";
import type { AstroConfig, BudgetConfig } from "./config";
import { providerAccountRefFor } from "./config";
import { activeLocks } from "./agent-lock";
import { budgetStatus } from "./budget";
import type { Ledger } from "./ledger";
import { quotaAvailable, type QuotaLimit } from "./quota";
import type { ModelEntry, Registry } from "./registry";
import { CAPACITY_TAGS, ROLE_TAGS } from "./tags";

/** Candidato ranqueado; `model` é a identidade composta `provider/id` (S-06). */
export interface ModelCandidate {
  model: string;
  profile?: string;
  tags: string[];
  /** Eficiência declarada do modelo (0..1); desempata quando falta preço. */
  efficiency: number;
  /** Pior custo da cadeia de provider para o contexto do modelo; null sem preço curado. */
  estimated_cost_max_usd: number | null;
}

/** Consulta feita pelo orchestrator. */
export interface CandidateQuery {
  /** Tag de papel (`ROLE_TAGS`): orienta o ranking, não bloqueia. */
  need: string;
  /** Tags de capacidade exatas (`CAPACITY_TAGS`): filtro duro. */
  requires?: string[];
  /** Entrada estimada para o filtro de contexto. */
  estimatedInputTokens?: number;
}

/** Dependências injetadas (o run fornece config/ledger/registry reais). */
export interface CandidateDeps {
  config: AstroConfig;
  registry: Registry;
  ledger: Ledger;
  quotaLimits?: Record<string, QuotaLimit>;
  budget?: BudgetConfig;
  /** Contas já presas (A4); default deriva dos locks ativos do ledger. */
  activeAccounts?: ReadonlySet<string>;
  /** Cooldown/health do profile ou modelo (M2); `true` exclui. */
  cooldown?: (candidate: { model: string; profile?: string; provider: string }) => boolean;
  now?: () => number;
}

/** Snapshot imutável devolvido pela tool e validado no spawn. */
export interface CandidateSnapshot {
  candidates: ModelCandidate[];
  snapshot_id: string;
  expires_at: string;
  ranking: "cost" | "no_price";
}

/** Escolha resolvida: candidato + razão gravada no ledger (M3, ≤200 chars). */
export interface ModelChoice {
  candidate: ModelCandidate;
  reason: string;
}

/** Erro de escolha com código estável (contrato de #128). */
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

/** Erro de snapshot expirado/invalidado: devolve a lista nova (golden §11.13). */
export class CandidateSetChangedError extends ModelChoiceError {
  readonly snapshot: CandidateSnapshot;

  constructor(message: string, snapshot: CandidateSnapshot) {
    super("candidate_set_changed", message, snapshot.candidates);
    this.name = "CandidateSetChangedError";
    this.snapshot = snapshot;
  }
}

const SNAPSHOT_TTL_MS = 5 * 60_000;
const REASON_LIMIT = 200;

interface StoredSnapshot {
  candidates: ModelCandidate[];
  query: CandidateQuery;
  expiresAtMs: number;
  healthRevision: number;
}

const SNAPSHOTS = new Map<string, StoredSnapshot>();
let healthRevision = 0;

/** Marca mudança de health/cooldown: invalida snapshots vivos (M2/A1). */
export function markModelHealthChanged(): void {
  healthRevision++;
}

/** Revisão atual de health/cooldown (exposta para testes e spawn). */
export function modelHealthRevision(): number {
  return healthRevision;
}

/** Limpa o store em testes. */
export function resetCandidateSnapshots(): void {
  SNAPSHOTS.clear();
  healthRevision = 0;
}

function isRoleTag(tag: string): boolean {
  return ROLE_TAGS.includes(tag);
}

function isCapacityTag(tag: string): boolean {
  return CAPACITY_TAGS.includes(tag);
}

/** Preço do modelo no provider de destino, com override global do Registry. */
function priceOf(config: AstroConfig, registry: Registry, provider: string, model: ModelEntry): ModelEntry["price"] {
  return registry.get(`${provider}/${model.id}`)?.price ?? (provider === model.provider ? model.price : undefined);
}

/**
 * Pior custo da cadeia (B9): primário + fallbacks declarados, contexto inteiro.
 * Sem preço em qualquer elo, o custo é desconhecido (M6/B6), nunca zero.
 */
function chainCostMax(config: AstroConfig, registry: Registry, model: ModelEntry): number | null {
  const chain = [model.provider, ...(config.providers[model.provider]?.fallback ?? [])];
  let total = 0;
  for (const provider of chain) {
    const price = priceOf(config, registry, provider, model);
    if (price === undefined) return null;
    total += (model.context * Math.max(price.inputPerM, price.outputPerM)) / 1e6;
  }
  return total;
}

/** O candidato passa pelo filtro duro (M2)? */
function passesFilter(
  model: ModelEntry,
  query: CandidateQuery,
  deps: CandidateDeps,
  activeAccounts: ReadonlySet<string>,
): boolean {
  if (model.status !== "active") return false;
  if (model.context < (query.estimatedInputTokens ?? 0)) return false;

  for (const required of query.requires ?? []) {
    if (!model.tags.includes(required)) return false;
    // "tools" também exige a capability declarada, não só a tag.
    if (required === "tools" && model.capabilities?.tools !== true) return false;
  }

  const providerConfig = deps.config.providers[model.provider];
  if (providerConfig === undefined) return false;
  if (activeAccounts.has(providerAccountRefFor(model.provider, providerConfig))) return false;
  if (deps.cooldown?.({ model: model.id, provider: model.provider }) === true) return false;

  const now = new Date(deps.now?.() ?? Date.now());
  const quotaDomain = providerConfig.quotaDomain ?? "default";
  if (!quotaAvailable(deps.ledger, deps.quotaLimits ?? {}, quotaDomain, now)) return false;

  if (deps.budget !== undefined) {
    const cost = chainCostMax(deps.config, deps.registry, model);
    const status = budgetStatus(deps.budget, deps.ledger, now);
    // Teto físico com preço desconhecido não pode ser provado abaixo do limite (B6).
    if (deps.budget.hardCeilingUsd !== undefined && cost === null) return false;
    if (cost !== null && status.remainingUsd !== null && cost > status.remainingUsd) return false;
  }
  return true;
}

/** Origem dos candidatos: modelPool (profile) ou modelos ativos sem pool. */
function sources(config: AstroConfig, registry: Registry): Array<{ model: ModelEntry; profile?: string }> {
  const profiles = Object.entries(config.modelPool ?? {});
  if (profiles.length > 0) {
    return profiles.map(([name]) => ({ model: registry.resolveProfile(name), profile: name }));
  }
  return registry.list().map((model) => ({ model }));
}

/**
 * Lista candidatos ranqueados e grava o snapshot (A1). `need` inválido →
 * `invalid_need`; `requires` fora de `CAPACITY_TAGS` → `invalid_requires`.
 */
export function listModelCandidates(query: CandidateQuery, deps: CandidateDeps): CandidateSnapshot {
  if (!isRoleTag(query.need)) {
    throw new ModelChoiceError("invalid_need", `need "${query.need}" não é um papel válido (${ROLE_TAGS.join(", ")})`);
  }
  for (const required of query.requires ?? []) {
    if (!isCapacityTag(required)) {
      throw new ModelChoiceError("invalid_requires", `requires "${required}" não é uma capacidade válida (${CAPACITY_TAGS.join(", ")})`);
    }
  }

  const activeAccounts = deps.activeAccounts ?? new Set(activeLocks(deps.ledger).map((lock) => lock.accountRef));
  const candidates: ModelCandidate[] = [];
  const seen = new Set<string>();

  for (const { model, profile } of sources(deps.config, deps.registry)) {
    if (!passesFilter(model, query, deps, activeAccounts)) continue;
    const identity = `${model.provider}/${model.id}`;
    const key = `${identity}|${profile ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      model: identity,
      ...(profile === undefined ? {} : { profile }),
      tags: model.tags,
      efficiency: model.efficiency ?? 0,
      estimated_cost_max_usd: chainCostMax(deps.config, deps.registry, model),
    });
  }

  const knownPrice = candidates.some((candidate) => candidate.estimated_cost_max_usd !== null);
  candidates.sort((a, b) => {
    const rankA = needRank(a, query.need);
    const rankB = needRank(b, query.need);
    if (rankA !== rankB) return rankA - rankB;
    if (knownPrice) {
      const aKnown = a.estimated_cost_max_usd !== null;
      const bKnown = b.estimated_cost_max_usd !== null;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown && a.estimated_cost_max_usd !== b.estimated_cost_max_usd) {
        return (a.estimated_cost_max_usd ?? 0) - (b.estimated_cost_max_usd ?? 0);
      }
    }
    return b.efficiency - a.efficiency;
  });

  const now = deps.now?.() ?? Date.now();
  const snapshot: CandidateSnapshot = {
    candidates,
    snapshot_id: createHash("sha256")
      .update(JSON.stringify({ candidates, query, issuedAt: now, revision: healthRevision }))
      .digest("hex"),
    expires_at: new Date(now + SNAPSHOT_TTL_MS).toISOString(),
    ranking: knownPrice ? "cost" : "no_price",
  };
  SNAPSHOTS.set(snapshot.snapshot_id, {
    candidates,
    query: { ...query, requires: query.requires === undefined ? undefined : [...query.requires] },
    expiresAtMs: now + SNAPSHOT_TTL_MS,
    healthRevision,
  });
  return snapshot;
}

/** Índice da tag `need` nas tags do modelo (0 = primária; 99 = ausente). */
function needRank(candidate: ModelCandidate, need: string): number {
  const index = candidate.tags.indexOf(need);
  return index === -1 ? 99 : index;
}

/**
 * Resolve a escolha no spawn: snapshot ausente/expirado ou health/cooldown
 * mudou → `candidate_set_changed` com a lista nova; modelo fora →
 * `invalid_model_choice`; omitido → rank 1 com `default_rank` (M3).
 */
export function resolveModelChoice(
  snapshotId: string,
  model: string | undefined,
  deps: CandidateDeps,
): ModelChoice {
  const stored = SNAPSHOTS.get(snapshotId);
  if (stored === undefined) {
    throw new ModelChoiceError("invalid_model_choice", `snapshot "${snapshotId}" não encontrado`);
  }
  const now = deps.now?.() ?? Date.now();
  if (now >= stored.expiresAtMs || healthRevision !== stored.healthRevision) {
    const fresh = listModelCandidates(stored.query, deps);
    throw new CandidateSetChangedError("snapshot expirado ou invalidado por health/cooldown", fresh);
  }

  const index = model === undefined ? 0 : stored.candidates.findIndex((candidate) => candidate.model === model);
  if (index < 0 || stored.candidates.length === 0) {
    throw new ModelChoiceError(
      "invalid_model_choice",
      model === undefined ? "snapshot sem candidatos" : `modelo "${model}" fora do snapshot`,
      stored.candidates,
    );
  }
  const candidate = stored.candidates[index]!;
  return {
    candidate,
    reason: model === undefined ? "default_rank" : `explicit_choice_rank_${index + 1}`.slice(0, REASON_LIMIT),
  };
}
