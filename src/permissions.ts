/**
 * Gate de permissão por chamada de tool (PERM-01, I-01).
 *
 * O allowlist do agente continua sendo a primeira barreira; este gate roda
 * depois dele e decide, por classe de ação, se a chamada segue (`allow`), se
 * precisa de aprovação humana (`ask`) ou se é negada (`deny`).
 *
 * Piso fixo: nenhum modo relaxa escrita em `.astro/`/`protectedPaths`, redação
 * de segredo ou confinamento no `cwd` — isso é aplicado pelas próprias tools e
 * continua valendo em `bypass`.
 */
import type { Tool } from "./tools/types";

export type PermissionMode = "bypass" | "allow-edits" | "ask";

/** Classes de ação que o gate distingue (PERM-02 formaliza no manifesto). */
export type ActionClass = "read_common" | "read_critical" | "edit" | "delete" | "shell" | "identity";

export type PermissionDecision = "allow" | "ask" | "deny";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

export const PERMISSION_MODES: readonly PermissionMode[] = ["bypass", "allow-edits", "ask"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

const MATRIX: Record<PermissionMode, Record<ActionClass, PermissionDecision>> = {
  bypass: {
    read_common: "allow", read_critical: "allow", edit: "allow", delete: "allow", shell: "allow", identity: "ask",
  },
  "allow-edits": {
    read_common: "allow", read_critical: "ask", edit: "allow", delete: "ask", shell: "ask", identity: "ask",
  },
  ask: {
    read_common: "allow", read_critical: "ask", edit: "ask", delete: "ask", shell: "ask", identity: "ask",
  },
};

/** Decisão do modo para a classe de ação. */
export function permissionDecision(mode: PermissionMode, action: ActionClass): PermissionDecision {
  return MATRIX[mode][action];
}

/** Precedência do modo: explícito (CLI) > config > `ask` (CLI-01 liga a flag). */
export function resolvePermissionMode(explicit: unknown, configured: unknown): PermissionMode {
  if (isPermissionMode(explicit)) return explicit;
  if (isPermissionMode(configured)) return configured;
  return DEFAULT_PERMISSION_MODE;
}

const CRITICAL_SEGMENTS: ReadonlySet<string> = new Set([".astro", ".git"]);
const CRITICAL_NAME = /(^|[._-])(secret|secrets|token|tokens|key|keys|password|passwd|credential|credentials)([._-]|$)/i;

/**
 * Leitura que pede aprovação mesmo em `allow-edits`: credenciais, config do
 * harness e estado do próprio ASTRO. PERM-03 troca esta lista por `CRITICAL_PATHS`.
 */
export function isCriticalReadPath(path: string): boolean {
  const segments = path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
  const base = segments.at(-1) ?? "";
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "astro.config.json" || base === "auth.json") return true;
  if (segments.some((segment) => CRITICAL_SEGMENTS.has(segment))) return true;
  return segments.some((segment) => CRITICAL_NAME.test(segment));
}

export interface ToolCallLike {
  name: string;
  input: unknown;
}

/** Classe da ação inferida do manifesto (até PERM-02 declarar `class`). */
export function actionClassOf(tool: Tool, call: ToolCallLike): ActionClass {
  if (call.name === "run_command" || tool.manifest.permission === "execute") return "shell";
  if (call.name === "read_file") {
    const path = (call.input as { path?: unknown } | null)?.path;
    return typeof path === "string" && isCriticalReadPath(path) ? "read_critical" : "read_common";
  }
  if (tool.manifest.permission === "write" || tool.manifest.sideEffects === "filesystem") return "edit";
  if (tool.manifest.sideEffects === "process") return "shell";
  return "read_common";
}
