import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import {
  HandoffError,
  buildHandoffArtifact,
  handoffId,
  taskHash,
  validateHandoffArtifact,
  type HandoffDraft,
} from "../src/handoff/types";

const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
const draft: HandoffDraft = {
  task: "implementar login", objective: "ter login funcionando",
  decisions: ["usar sessão"], constraints: ["sem dependência"], next_steps: ["testar"],
};
const build = (over: Partial<Parameters<typeof buildHandoffArtifact>[0]> = {}) =>
  buildHandoffArtifact({
    run: "r1", from: "planner", to: "coder", sourceStep: 1,
    budgetSpent: { tokens: 10, usd: 0.01 }, draft, ...over,
  });
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return e instanceof HandoffError ? e.code : `erro: ${String(e)}`;
  }
};

describe("handoff_id determinístico (F-23, ADR-0006)", () => {
  test("id = sha256(run|from|to|taskHash|source_step) e é estável", () => {
    const a = build();
    const expected = createHash("sha256")
      .update(`r1|planner|coder|${taskHash(draft.task, draft.objective)}|1`)
      .digest("hex");
    expect(handoffId(a)).toBe(expected);
    expect(handoffId(build())).toBe(expected);
  });

  test("decisions/constraints/next_steps não mudam o id; run/to/source_step/objetivo mudam", () => {
    const base = handoffId(build());
    const outros = build({ draft: { ...draft, decisions: ["outra"], constraints: [], next_steps: [] } });
    expect(handoffId(outros)).toBe(base);
    expect(handoffId(build({ run: "r2" }))).not.toBe(base);
    expect(handoffId(build({ to: "reviewer" }))).not.toBe(base);
    expect(handoffId(build({ sourceStep: 2 }))).not.toBe(base);
    expect(handoffId(build({ draft: { ...draft, objective: "outro" } }))).not.toBe(base);
  });
});

describe("HandoffArtifactV1 (F-23)", () => {
  test("artefato válido carrega version 1, campos e profiles opcionais", () => {
    const a = build({ fromProfile: "premium", toProfile: "cheap" });
    expect(validateHandoffArtifact(a)).toEqual(a);
    expect(a.version).toBe(1);
    expect(a.from_profile).toBe("premium");
    expect(a.budget_spent).toEqual({ tokens: 10, usd: 0.01 });
  });

  test("rejeita campos ausentes/inválidos com handoff_artifact_mismatch", () => {
    const bad = [
      { ...build(), objective: "" },
      { ...build(), version: 2 },
      { ...build(), source_step: -1 },
      { ...build(), decisions: [1] },
      { ...build(), budget_spent: { tokens: -1, usd: 0 } },
    ];
    for (const value of bad) expect(codeOf(() => validateHandoffArtifact(value))).toBe("handoff_artifact_mismatch");
  });
});

describe("ledger com handoff (F-23)", () => {
  test("recordHandoff grava created/received e readAll continua só de uso", () => {
    const l = new Ledger(join(mkdtempSync(join(tmpdir(), "astro-f23-")), "ledger.jsonl"));
    const a = build();
    l.record({ run: "r1", agent: "planner", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 1 }, price);
    const created = l.recordHandoff("handoff.created", "r1", a);
    expect(created.kind).toBe("handoff.created");
    expect(created.handoff_id).toBe(handoffId(a));
    expect(l.readAll()).toHaveLength(1);
    expect(l.readHandoffs().map((e) => e.kind)).toEqual(["handoff.created"]);
    l.recordState("r1", "completed");
    expect(l.readAll()).toHaveLength(1);
    expect(l.readAllEntries()).toHaveLength(3);
  });
});
