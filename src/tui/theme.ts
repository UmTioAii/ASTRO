/** Configuração da TUI (T2): tema e último modelo em `.astro/tui.json`. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = "dark" | "light";

export interface TuiConfig {
  theme: Theme;
  lastModel?: string;
}

export interface ThemeColors {
  /** Cor de destaque: prompt, borda do input e entradas do usuário. */
  accent: string;
  /** Avisos: pergunta pendente e turno em andamento. */
  warning: string;
  /** Erros. */
  error: string;
}

const DEFAULT_CONFIG: TuiConfig = { theme: "dark" };

function configPath(cwd: string): string {
  return join(cwd, ".astro", "tui.json");
}

/** Lê a configuração; arquivo ausente ou inválido cai no default. */
export function loadTuiConfig(cwd: string): TuiConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(cwd), "utf8"));
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    const record = parsed as Record<string, unknown>;
    const theme: Theme = record.theme === "light" ? "light" : "dark";
    return typeof record.lastModel === "string" && record.lastModel !== ""
      ? { theme, lastModel: record.lastModel }
      : { theme };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Grava a configuração mesclando com o que já existe (tema + último modelo). */
export function saveTuiConfig(cwd: string, config: Partial<TuiConfig>): void {
  const current = loadTuiConfig(cwd);
  const lastModel = config.lastModel ?? current.lastModel;
  const merged: TuiConfig = {
    theme: config.theme ?? current.theme,
    ...(lastModel === undefined ? {} : { lastModel }),
  };
  mkdirSync(join(cwd, ".astro"), { recursive: true });
  writeFileSync(configPath(cwd), `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** Cores por tema; o fundo do terminal não é alterado. */
export function getThemeColors(theme: Theme): ThemeColors {
  return theme === "light"
    ? { accent: "blue", warning: "yellow", error: "red" }
    : { accent: "cyan", warning: "yellow", error: "red" };
}
