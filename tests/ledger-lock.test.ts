import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LedgerLockError } from "../src/ledger";

function ledger(): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), "astro-lockfile-")), "ledger.jsonl"));
}

describe("lock de arquivo do ledger (F-26, A4)", () => {
  test("seção crítica roda e o lock é removido mesmo com erro", () => {
    const l = ledger();
    const lockPath = `${l.path}.lock`;

    expect(l.withFileLock(() => 42)).toBe(42);
    expect(existsSync(lockPath)).toBe(false);

    expect(() => l.withFileLock(() => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("lock órfão de PID morto é detectado como stale e removido", () => {
    const l = ledger();
    const lockPath = `${l.path}.lock`;
    writeFileSync(lockPath, "999999", "utf8");

    const result = l.withFileLock(() => "ok", { failClosed: true, timeoutMs: 20 });

    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("dono vivo com failClosed falha em vez de executar sem exclusividade", () => {
    const l = ledger();
    const lockPath = `${l.path}.lock`;
    writeFileSync(lockPath, String(process.pid), "utf8");
    try {
      let ran = false;
      expect(() => l.withFileLock(() => { ran = true; }, { failClosed: true, timeoutMs: 20 }))
        .toThrow(LedgerLockError);
      expect(ran).toBe(false);
      // Compat do CAS de handoff: sem failClosed segue em melhor esforço.
      expect(l.withFileLock(() => "best-effort", { timeoutMs: 20 })).toBe("best-effort");
    } finally {
      writeFileSync(lockPath, "", "utf8");
    }
  });
});
