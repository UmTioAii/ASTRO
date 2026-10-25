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

const RETRYABLE: ReadonlySet<HandoffErrorCode> = new Set(["handoff_ack_timeout"]);

/** Erro de handoff com código estável; nenhuma classe nova em D-18. */
export class HandoffError extends ToolError {
  readonly code: HandoffErrorCode;
  readonly retryable: boolean;
  readonly errClass: ErrorClass;

  constructor(code: HandoffErrorCode, message: string) {
    super(`${code}: ${redactSecrets(message)}`);
    this.name = "HandoffError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
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
  /** Questões abertas; primeiro campo dropado na compactação (F-25). */
  open_questions?: string[];
}

/** Custo gasto até o handoff; leitura do ledger, nunca contador paralelo (D-10). */
export interface HandoffBudget {
  tokens: number;
  usd: number;
}

/** Intervalo do ledger de onde o artefato veio (F-25, ADR-0006). */
export interface HandoffSourceRefs {
  /** sha256 do caminho absoluto do ledger; sobrevive a renomeação de rotação. */
  ledger_id: string;
  seq_start: number;
  seq_end: number;
}

/** Artefato citado pelo emissor: caminho relativo ao cwd + digest do conteúdo. */
export interface HandoffArtifactRef {
  path: string;
  digest: string;
}

/** Auditoria da compactação lossy (F-25): o que foi perdido e como. */
export interface HandoffCompaction {
  strategy: "summary" | "truncate" | "none";
  droppedFields: string[];
}

/** Metadados de truncamento do nível compacto, consistentes com F-09. */
export interface HandoffTruncation {
  truncated: boolean;
  originalTokens: number;
  returnedTokens: number;
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
  source_refs?: HandoffSourceRefs;
  artifacts?: HandoffArtifactRef[];
  compaction?: HandoffCompaction;
  truncated?: boolean;
  originalTokens?: number;
  returnedTokens?: number;
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
  sourceRefs?: HandoffSourceRefs;
  artifacts?: HandoffArtifactRef[];
  compaction?: HandoffCompaction;
  truncation?: HandoffTruncation;
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
 * `run`/`from`/`to` e `task`/`objective` são sanitizados antes do hash (I-03),
 * de modo que o id calculado aqui é o mesmo do artefato persistido.
 */
export function handoffId(a: Pick<HandoffArtifactV1, "run" | "from" | "to" | "source_step" | "task" | "objective">): string {
  return sha256(
    `${redactSecrets(a.run)}|${redactSecrets(a.from)}|${redactSecrets(a.to)}|${taskHash(redactSecrets(a.task), redactSecrets(a.objective))}|${a.source_step}`,
  );
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

/** Valida lista de strings obrigatória (artefato v1). */
function asRequiredStringArray(value: unknown, field: string): string[] {
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

function asPositiveInt(value: unknown, field: string): number {
  const n = asNonNegative(value, field);
  if (!Number.isInteger(n) || n < 1) mismatch(`campo "${field}" deve ser inteiro positivo`);
  return n;
}

const COMPACTION_STRATEGIES: readonly string[] = ["summary", "truncate", "none"];
/** Campos que a compactação pode dropar (F-25): open_questions, depois decisions. */
const DROPPABLE_FIELDS: readonly string[] = ["open_questions", "decisions"];

/** Valida os campos opcionais de compactação/referência (F-25). */
function validateCompactFields(raw: Record<string, unknown>): {
  source_refs?: HandoffSourceRefs;
  artifacts?: HandoffArtifactRef[];
  compaction?: HandoffCompaction;
  truncation?: HandoffTruncation;
} {
  const refs = raw.source_refs === undefined ? undefined : (() => {
    const o = asObject(raw.source_refs, "source_refs");
    const ledgerId = asString(o.ledger_id, "source_refs.ledger_id");
    if (!/^[0-9a-f]{64}$/.test(ledgerId)) mismatch('campo "source_refs.ledger_id" deve ser sha256 em hex');
    const seq_start = asPositiveInt(o.seq_start, "source_refs.seq_start"), seq_end = asPositiveInt(o.seq_end, "source_refs.seq_end");
    if (seq_start > seq_end) mismatch('campo "source_refs" precisa de seq_start <= seq_end');
    return { ledger_id: ledgerId, seq_start, seq_end };
  })();
  const artifacts = raw.artifacts === undefined ? undefined : (() => {
    if (!Array.isArray(raw.artifacts)) mismatch('campo "artifacts" deve ser lista');
    return raw.artifacts.map((item: unknown) => {
      const o = asObject(item, "artifacts[]");
      const digest = asString(o.digest, "artifacts[].digest");
      if (!/^[0-9a-f]{64}$/.test(digest)) mismatch('campo "artifacts[].digest" deve ser sha256 em hex');
      return { path: asString(o.path, "artifacts[].path"), digest };
    });
  })();
  const compaction = raw.compaction === undefined ? undefined : (() => {
    const o = asObject(raw.compaction, "compaction");
    if (!COMPACTION_STRATEGIES.includes(o.strategy as string)) mismatch(`campo "compaction.strategy" deve ser um de ${COMPACTION_STRATEGIES.join(", ")}`);
    const droppedFields = asRequiredStringArray(o.droppedFields, "compaction.droppedFields");
    if (droppedFields.some((f) => !DROPPABLE_FIELDS.includes(f))) mismatch(`campo "compaction.droppedFields" aceita só ${DROPPABLE_FIELDS.join(", ")}`);
    return { strategy: o.strategy as HandoffCompaction["strategy"], droppedFields };
  })();
  const truncation = raw.truncated === undefined && raw.originalTokens === undefined && raw.returnedTokens === undefined
    ? undefined
    : (() => {
      if (raw.truncated !== true) mismatch('campo "truncated" deve ser true quando os metadados existem');
      return { truncated: true, originalTokens: asNonNegative(raw.originalTokens, "originalTokens"), returnedTokens: asNonNegative(raw.returnedTokens, "returnedTokens") };
    })();
  return {
    ...(refs === undefined ? {} : { source_refs: refs }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(truncation === undefined ? {} : truncation),
  };
}

/** Valida e normaliza o conteúdo declarado pelo emissor (payload da tool). */
export function validateHandoffDraft(value: unknown): HandoffDraft {
  const raw = asObject(value, "handoff");
  return {
    task: asString(raw.task, "task"),
    objective: asString(raw.objective, "objective"),
    decisions: asRequiredStringArray(raw.decisions, "decisions"),
    constraints: asRequiredStringArray(raw.constraints, "constraints"),
    next_steps: asRequiredStringArray(raw.next_steps, "next_steps"),
    ...(raw.open_questions === undefined ? {} : { open_questions: asRequiredStringArray(raw.open_questions, "open_questions") }),
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
    ...validateCompactFields(raw),
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
    // Copia só os campos do contrato: o draft não pode sobrescrever a
    // identidade/execução vinda do runtime (F-23, D-10).
    task: args.draft.task,
    objective: args.draft.objective,
    decisions: args.draft.decisions,
    constraints: args.draft.constraints,
    next_steps: args.draft.next_steps,
    ...(args.draft.open_questions === undefined ? {} : { open_questions: args.draft.open_questions }),
    ...(args.fromProfile === undefined ? {} : { from_profile: args.fromProfile }),
    ...(args.toProfile === undefined ? {} : { to_profile: args.toProfile }),
    ...(args.sourceRefs === undefined ? {} : { source_refs: args.sourceRefs }),
    ...(args.artifacts === undefined || args.artifacts.length === 0 ? {} : { artifacts: args.artifacts }),
    // Compactação sempre auditada: sem perda é strategy "none" (F-25)
    compaction: args.compaction ?? { strategy: "none", droppedFields: [] },
    ...(args.truncation === undefined ? {} : args.truncation),
  });
}

/**
 * Sanitiza o artefato antes de persistir (I-03): redige padrões de segredo nos
 * campos textuais. `budget_spent` é numérico e permanece intacto.
 */
export function sanitizeHandoffArtifact(a: HandoffArtifactV1): HandoffArtifactV1 {
  return {
    ...a,
    run: redactSecrets(a.run), from: redactSecrets(a.from), to: redactSecrets(a.to), task: redactSecrets(a.task),
    objective: redactSecrets(a.objective),
    decisions: a.decisions.map(redactSecrets),
    constraints: a.constraints.map(redactSecrets),
    next_steps: a.next_steps.map(redactSecrets),
    ...(a.open_questions === undefined ? {} : { open_questions: a.open_questions.map(redactSecrets) }),
    ...(a.from_profile === undefined ? {} : { from_profile: redactSecrets(a.from_profile) }),
    ...(a.to_profile === undefined ? {} : { to_profile: redactSecrets(a.to_profile) }),
    ...(a.artifacts === undefined ? {} : { artifacts: a.artifacts.map((r) => ({ ...r, path: redactSecrets(r.path) })) }),
    ...(a.compaction === undefined ? {} : { compaction: { ...a.compaction, droppedFields: a.compaction.droppedFields.map(redactSecrets) } }),
  };
}
