/** Configuração da TUI (T2): tema e último modelo em `.astro/tui.json`. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ConfigError } from "../config";

export type Theme = "dark" | "light";

export interface TuiConfig {
  theme: Theme;
  lastModel?: string;
}

export type ThemeColors = { accent: string; warning: string; error: string };

const DEFAULT_CONFIG: TuiConfig = { theme: "dark" };

function configPath(cwd: string): string {
  return join(cwd, ".astro", "tui.json");
}

/** Garante que o alvo existente fica dentro do cwd canônico, seguindo links (I-11). */
function assertInside(cwd: string, path: string): void {
  const rel = relative(realpathSync(cwd), realpathSync(path));
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) throw new ConfigError("config da TUI fora do cwd");
}

/** Lê a configuração; arquivo ausente, inválido ou fora do cwd cai no default. */
export function loadTuiConfig(cwd: string): TuiConfig {
  try {
    const file = configPath(cwd);
    if (existsSync(file)) assertInside(cwd, file);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    const record = parsed as Record<string, unknown>;
    const theme: Theme = record.theme === "light" ? "light" : "dark";
    const lastModel = typeof record.lastModel === "string" && record.lastModel !== "" ? record.lastModel : undefined;
    return { theme, ...(lastModel === undefined ? {} : { lastModel }) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Grava a configuração mesclando com o que já existe (tema + último modelo). */
export function saveTuiConfig(cwd: string, config: Partial<TuiConfig>): void {
  const current = loadTuiConfig(cwd);
  const lastModel = config.lastModel ?? current.lastModel;
  const merged: TuiConfig = { theme: config.theme ?? current.theme, ...(lastModel === undefined ? {} : { lastModel }) };
  const dir = join(cwd, ".astro");
  mkdirSync(dir, { recursive: true });
  assertInside(cwd, dir);
  const file = configPath(cwd);
  if (existsSync(file)) assertInside(cwd, file);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** Cores por tema; o fundo do terminal não é alterado. */
export function getThemeColors(theme: Theme): ThemeColors {
  return { accent: theme === "light" ? "blue" : "cyan", warning: "yellow", error: "red" };
}
