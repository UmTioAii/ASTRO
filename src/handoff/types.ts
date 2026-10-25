import { createHash } from "node:crypto";
import type { ErrorClass } from "../provider/types";
import { redactSecrets } from "../sanitize-external";
import { ToolError } from "../tools/types";

/** Códigos estáveis de erro de handoff (ADR-0006); mapeados à taxonomia fixa de D-18. */
export type HandoffErrorCode =
  | "handoff_target_not_found"
  | "handoff_mismatch"
  | "handoff_artifact_mismatch"
  | "handoff_ack_timeout";

const RETRYABLE: Record<HandoffErrorCode, boolean> = {
  handoff_target_not_found: false,
  handoff_mismatch: false,
  handoff_artifact_mismatch: false,
  handoff_ack_timeout: true,
};

/** Erro de handoff com código estável; nenhuma classe nova em D-18. */
export class HandoffError extends ToolError {
  readonly code: HandoffErrorCode;
  readonly retryable: boolean;
  readonly errClass: ErrorClass;

  constructor(code: HandoffErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HandoffError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.errClass = this.retryable ? "transient_rate_limit" : "invalid_request";
  }
}

/** Conteúdo declarado pelo emissor; o runtime completa os campos de execução. */
export interface HandoffDraft {
  task: string;
  objective: string;
  decisions: string[];
  constraints: string[];
  next_steps: string[];
}

/** Custo gasto até o handoff; leitura do ledger, nunca contador paralelo (D-10). */
export interface HandoffBudget {
  tokens: number;
  usd: number;
}

/** Artefato durável v1 (ADR-0006): versionado e idempotente por `handoff_id`. */
export interface HandoffArtifactV1 extends HandoffDraft {
  version: 1;
  run: string;
  from: string;
  to: string;
  source_step: number;
  budget_spent: HandoffBudget;
  from_profile?: string;
  to_profile?: string;
}

export interface HandoffBuildArgs {
  run: string;
  from: string;
  to: string;
  sourceStep: number;
  budgetSpent: HandoffBudget;
  draft: HandoffDraft;
  fromProfile?: string;
  toProfile?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash estável de task + objective; base do `handoff_id`. */
export function taskHash(task: string, objective: string): string {
  return sha256(`${task}|${objective}`);
}

/**
 * `handoff_id = sha256(run|from|to|taskHash|source_step)` (ADR-0006).
 *
 * Mudanças em `decisions`/`constraints`/`next_steps` NÃO alteram o id — a
 * estabilidade é o que permite o verifier e o lock de via única (F-26).
 */
export function handoffId(a: Pick<HandoffArtifactV1, "run" | "from" | "to" | "source_step" | "task" | "objective">): string {
  return sha256(`${a.run}|${a.from}|${a.to}|${taskHash(a.task, a.objective)}|${a.source_step}`);
}

function mismatch(message: string): never {
  throw new HandoffError("handoff_artifact_mismatch", message);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    mismatch(`campo "${field}" deve ser objeto`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    mismatch(`campo "${field}" deve ser string não vazia`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    mismatch(`campo "${field}" deve ser lista de strings`);
  }
  return value as string[];
}

function asNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    mismatch(`campo "${field}" deve ser número não negativo`);
  }
  return value;
}

/** Valida e normaliza o conteúdo declarado pelo emissor (payload da tool). */
export function validateHandoffDraft(value: unknown): HandoffDraft {
  const raw = asObject(value, "handoff");
  return {
    task: asString(raw.task, "task"),
    objective: asString(raw.objective, "objective"),
    decisions: asStringArray(raw.decisions, "decisions"),
    constraints: asStringArray(raw.constraints, "constraints"),
    next_steps: asStringArray(raw.next_steps, "next_steps"),
  };
}

/** Valida o artefato completo; rejeita com `handoff_artifact_mismatch`. */
export function validateHandoffArtifact(value: unknown): HandoffArtifactV1 {
  const raw = asObject(value, "artifact");
  if (raw.version !== 1) mismatch('campo "version" deve ser 1');
  const budget = asObject(raw.budget_spent, "budget_spent");
  const sourceStep = asNonNegative(raw.source_step, "source_step");
  if (!Number.isInteger(sourceStep)) mismatch('campo "source_step" deve ser inteiro');
  const tokens = asNonNegative(budget.tokens, "budget_spent.tokens");
  if (!Number.isInteger(tokens)) mismatch('campo "budget_spent.tokens" deve ser inteiro');

  return {
    version: 1,
    run: asString(raw.run, "run"),
    from: asString(raw.from, "from"),
    to: asString(raw.to, "to"),
    source_step: sourceStep,
    budget_spent: { tokens, usd: asNonNegative(budget.usd, "budget_spent.usd") },
    ...validateHandoffDraft(raw),
    ...(raw.from_profile === undefined ? {} : { from_profile: asString(raw.from_profile, "from_profile") }),
    ...(raw.to_profile === undefined ? {} : { to_profile: asString(raw.to_profile, "to_profile") }),
  };
}

/** Monta o artefato completo a partir do draft + estado de execução e valida. */
export function buildHandoffArtifact(args: HandoffBuildArgs): HandoffArtifactV1 {
  return validateHandoffArtifact({
    version: 1,
    run: args.run,
    from: args.from,
    to: args.to,
    source_step: args.sourceStep,
    budget_spent: args.budgetSpent,
    ...args.draft,
    ...(args.fromProfile === undefined ? {} : { from_profile: args.fromProfile }),
    ...(args.toProfile === undefined ? {} : { to_profile: args.toProfile }),
  });
}

/**
 * Sanitiza o artefato antes de persistir (I-03): redige padrões de segredo nos
 * campos livres. `budget_spent` é numérico e permanece intacto.
 */
export function sanitizeHandoffArtifact(a: HandoffArtifactV1): HandoffArtifactV1 {
  return {
    ...a,
    task: redactSecrets(a.task),
    objective: redactSecrets(a.objective),
    decisions: a.decisions.map(redactSecrets),
    constraints: a.constraints.map(redactSecrets),
    next_steps: a.next_steps.map(redactSecrets),
    ...(a.from_profile === undefined ? {} : { from_profile: redactSecrets(a.from_profile) }),
    ...(a.to_profile === undefined ? {} : { to_profile: redactSecrets(a.to_profile) }),
  };
}
