import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, handoffId, type HandoffDraft } from "../src/handoff/types";

// Segredos montados em runtime para não vazar literais no diff (G6)
const NV = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
const SK = ["s", "k", "-"].join("") + "abcdef1234567890";
const BEARER = ["B", "e", "a", "r", "e", "r"].join("") + " abcdef+/=1234567890";
const bearerLower = BEARER.toLowerCase();

const draft = (): HandoffDraft => ({
  task: `tarefa ${NV}`, objective: `objetivo ${BEARER}`,
  decisions: [`decisão ${SK}`, NV], constraints: [], next_steps: [BEARER, bearerLower],
});

describe("segurança F-23: segredo no handoff nunca chega ao ledger in natura (I-03)", () => {
  test("recordHandoff sanitiza o artefato antes de gravar e preserva budget", () => {
    const path = join(mkdtempSync(join(tmpdir(), "astro-f23-sec-")), "ledger.jsonl");
    const artifact = buildHandoffArtifact({
      run: `run ${NV}`, from: `from ${SK}`, to: `to ${BEARER}`, sourceStep: 1,
      budgetSpent: { tokens: 42, usd: 0.5 }, draft: draft(),
    });
    const entry = new Ledger(path).recordHandoff("handoff.created", "r1", artifact);
    const raw = readFileSync(path, "utf8");
    for (const secret of [NV, SK, BEARER, bearerLower]) expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
    expect(entry.artifact.budget_spent).toEqual({ tokens: 42, usd: 0.5 });
    expect(entry.handoff_id).toBe(handoffId(artifact));
    expect(entry.handoff_id).toMatch(/^[0-9a-f]{64}$/);
  });
});
