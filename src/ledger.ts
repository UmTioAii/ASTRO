import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PriceConfig } from "./config";

export interface LedgerEntry {
  ts: string;
  run: string;
  agent: string;
  provider: string;
  model: string;
  credentialRef: string;
  quotaDomain: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** Custo em USD para os tokens informados, ou null quando não há preço curado. */
export function estimateCost(
  tokensIn: number,
  tokensOut: number,
  price?: PriceConfig,
): number | null {
  if (price === undefined) return null;
  return (tokensIn / 1_000_000) * price.inputPerM + (tokensOut / 1_000_000) * price.outputPerM;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Ledger de uso append-only em JSONL, com custo estimado por entrada. */
export class Ledger {
  private readonly path: string;
  private readonly warn: (msg: string) => void;

  constructor(path: string, opts?: { warn?: (msg: string) => void }) {
    this.path = path;
    this.warn = opts?.warn ?? ((msg) => console.warn(msg));
    mkdirSync(dirname(path), { recursive: true });
  }

  record(e: Omit<LedgerEntry, "ts" | "costUsd">, price?: PriceConfig): LedgerEntry {
    const costUsd = estimateCost(e.tokensIn, e.tokensOut, price);
    if (costUsd === null) {
      this.warn(
        `sem preço curado para o modelo "${e.provider}/${e.model}"; custo não calculado`,
      );
    }
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      ...e,
      costUsd,
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  readAll(): LedgerEntry[] {
    return this.readLines().map((line) => JSON.parse(line) as LedgerEntry);
  }

  total(): { tokensIn: number; tokensOut: number; costUsd: number } {
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    for (const entry of this.readAll()) {
      tokensIn += entry.tokensIn;
      tokensOut += entry.tokensOut;
      costUsd += entry.costUsd ?? 0;
    }
    return { tokensIn, tokensOut, costUsd };
  }

  private readLines(): string[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }
}
