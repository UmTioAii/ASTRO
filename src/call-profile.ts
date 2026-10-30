/**
 * Call profile por modelo (E1–E8, ADR-0012): escala `lvl` 0–4 sobre o effort
 * map do provider, thinking independente, parâmetros proibidos removidos antes
 * do envio. Nada aqui persiste texto de raciocínio (I-03).
 */

/** Modos de thinking suportados pelo schema (E2). */
export type ThinkingMode = "toggle" | "always" | "adaptive" | "none";

/** Configuração de thinking de um modelo. */
export interface ThinkingConfig {
  mode: ThinkingMode;
  /** Caminho do parâmetro no corpo do provider (ex.: `thinking.type`). */
  param: string;
  /** Valor enviado quando ligado. */
  on?: string;
  /** Valor enviado quando desligado (modo `toggle`). */
  off?: string;
}

/** Níveis válidos da escala (E1). */
export type EffortLevel = "0" | "1" | "2" | "3" | "4";

/** Configuração de esforço de um modelo (E1). */
export interface EffortConfig {
  /** Caminho do parâmetro no corpo do provider (ex.: `reasoning.effort`). */
  param: string;
  /** `lvl` 0..4 → valor aceito pelo provider. */
  map: Record<EffortLevel, string>;
}

/** Seção `call` de um modelo. */
export interface CallConfig {
  thinking?: ThinkingConfig;
  effort?: EffortConfig;
  /** Caminhos removidos antes do envio, gravados como `param.stripped` (E8). */
  forbidden?: string[];
}

/** Escolha de chamada em runtime (E3–E5). */
export interface CallSelection {
  /** 0 = low … 4 = ultra; default 2 quando o modelo declara effort. */
  lvl?: number;
  /** Estado do modo `toggle`; default `on`. */
  thinking?: "on" | "off";
}

/** Parâmetro proibido que existia no corpo e foi removido. */
export interface StrippedParam {
  name: string;
  reason: string;
}

/** O que foi efetivamente aplicado à chamada (E7). */
export interface AppliedCallProfile {
  lvl?: number;
  effort?: string;
  thinking?: string;
  stripped: StrippedParam[];
}

/** Raízes que nunca podem entrar em `call.forbidden` (quebrariam o protocolo). */
export const PROTECTED_FORBIDDEN_ROOTS = [
  "model",
  "messages",
  "input",
  "stream",
  "stream_options",
  "tools",
  "instructions",
] as const;

/** Decisão de mudança de esforço (E4/E5). */
export type EffortDecision =
  | { allowed: true; approvalRequired: boolean; level: number; reason: "same" | "down" | "up_auto" | "up_approved" }
  | { allowed: false; approvalRequired: boolean; level: number; reason: "fixed" | "up_needs_approval" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normaliza e valida um nível 0..4. */
export function normalizeLevel(lvl: number): number {
  if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4) {
    throw new RangeError(`nível de esforço inválido: ${String(lvl)} (esperado inteiro 0..4)`);
  }
  return lvl;
}

/** Escreve um valor em caminho `a.b.c`, criando objetos intermediários. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (isRecord(next)) {
      current = next;
      continue;
    }
    const created: Record<string, unknown> = {};
    current[part] = created;
    current = created;
  }
  current[parts.at(-1)!] = value;
}

/** Remove um caminho; devolve `true` só quando a folha existia. Limpa objetos vazios. */
function deletePath(target: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  const trail: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) return false;
    trail.push({ parent: current, key: part });
    current = next;
  }
  const leaf = parts.at(-1)!;
  if (!Object.hasOwn(current, leaf)) return false;
  delete current[leaf];
  for (let index = trail.length - 1; index >= 0; index--) {
    const { parent, key } = trail[index]!;
    const child = parent[key];
    if (isRecord(child) && Object.keys(child).length === 0) {
      delete parent[key];
      continue;
    }
    break;
  }
  return true;
}

/** Resolve lvl/effort/thinking a partir da config do modelo e da escolha runtime. */
export function resolveCallProfile(
  config: CallConfig | undefined,
  selection: CallSelection = {},
): AppliedCallProfile {
  if (config === undefined) return { stripped: [] };

  const applied: AppliedCallProfile = { stripped: [] };
  if (config.effort !== undefined) {
    const lvl = normalizeLevel(selection.lvl ?? 2);
    applied.lvl = lvl;
    applied.effort = config.effort.map[String(lvl) as EffortLevel];
  }
  if (config.thinking !== undefined && config.thinking.mode !== "none") {
    const value = config.thinking.mode === "toggle"
      ? (selection.thinking === "off" ? config.thinking.off : config.thinking.on)
      : config.thinking.on;
    if (value !== undefined) applied.thinking = value;
  }
  return applied;
}

/** Aplica o perfil ao corpo do provider e remove os proibidos (E8). */
export function applyCallToBody(
  body: Record<string, unknown>,
  config: CallConfig | undefined,
  selection: CallSelection = {},
): AppliedCallProfile {
  const applied = resolveCallProfile(config, selection);
  if (config === undefined) return applied;

  if (config.effort !== undefined && applied.lvl !== undefined && applied.effort !== undefined) {
    setPath(body, config.effort.param, applied.effort);
  }
  if (config.thinking !== undefined && applied.thinking !== undefined) {
    setPath(body, config.thinking.param, applied.thinking);
  }

  for (const name of config.forbidden ?? []) {
    if (!deletePath(body, name)) continue;
    applied.stripped.push({ name, reason: "forbidden" });
    // O valor foi calculado mas não enviado; não pode aparecer como aplicado.
    // `name` pode ser ancestral do parâmetro (ex.: "reasoning" cobre "reasoning.effort").
    const covers = (param: string | undefined): boolean =>
      param !== undefined && (param === name || param.startsWith(`${name}.`));
    if (covers(config.effort?.param)) delete applied.effort;
    if (covers(config.thinking?.param)) delete applied.thinking;
  }
  return applied;
}

/** Plano de mudança de esforço: descer e subir 1–2 é automático; 3+ pede aprovação (E4/E5). */
export function planEffortChange(
  from: number,
  to: number,
  opts: { fixed?: boolean } = {},
): EffortDecision {
  const current = normalizeLevel(from);
  const target = normalizeLevel(to);
  if (opts.fixed === true) {
    return { allowed: false, approvalRequired: false, level: current, reason: "fixed" };
  }
  if (target < current) {
    return { allowed: true, approvalRequired: false, level: target, reason: "down" };
  }
  if (target === current) {
    return { allowed: true, approvalRequired: false, level: target, reason: "same" };
  }
  if (target - current <= 2) {
    return { allowed: true, approvalRequired: false, level: target, reason: "up_auto" };
  }
  return { allowed: false, approvalRequired: true, level: current, reason: "up_needs_approval" };
}

/** Aplica a mudança, consultando o approver quando E4 exige. */
export async function applyEffortChange(
  from: number,
  to: number,
  opts: { fixed?: boolean; approve?: (from: number, to: number) => boolean | Promise<boolean> } = {},
): Promise<EffortDecision> {
  const decision = planEffortChange(from, to, opts);
  if (!decision.approvalRequired) return decision;
  if (opts.approve === undefined) return decision;

  const approved = await opts.approve(normalizeLevel(from), normalizeLevel(to));
  if (!approved) return decision;
  return {
    allowed: true,
    approvalRequired: false,
    level: normalizeLevel(to),
    reason: "up_approved",
  };
}
