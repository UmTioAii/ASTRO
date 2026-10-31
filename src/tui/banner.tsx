/** Banner da TUI (T3): versão do pacote, provider, modelo, endpoint e estado; usa theme. */
import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import type { ThemeColors } from "./theme";

let cachedVersion: string | undefined;

/** Versão do pacote lida de package.json (cacheada em módulo); "desconhecida" se ilegível. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    cachedVersion = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "desconhecida";
  } catch {
    cachedVersion = "desconhecida";
  }
  return cachedVersion;
}

export interface BannerData {
  provider: string;
  model: string;
  endpoint: string;
  state: string;
  /** Injetável em testes; default lê package.json. */
  version?: string;
}

/** Linha única do banner (pura, testável). */
export function bannerLine(data: BannerData): string {
  return `ASTRO v${data.version ?? packageVersion()} · ${data.provider} · ${data.model} · ${data.endpoint} · estado: ${data.state}`;
}

export function Banner({ colors, ...data }: BannerData & { colors: ThemeColors }): ReactElement {
  const lineColor = data.state === "ok" ? colors.accent : data.state === "down" ? colors.error : undefined;
  return (
    <Box borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={lineColor}>{bannerLine(data)}</Text>
    </Box>
  );
}
