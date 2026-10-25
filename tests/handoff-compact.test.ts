import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { buildHandoffArtifact, handoffId, HandoffError, sanitizeHandoffArtifact, validateHandoffArtifact, type HandoffArtifactV1, type HandoffDraft } from "../src/handoff/types";
import { compactDraft, digestArtifacts, validateArtifacts } from "../src/handoff/compact";

const dir = () => mkdtempSync(join(tmpdir(), "astro-f25-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const big = (n: number) => "x".repeat(n);
const draft = (): HandoffDraft => ({ task: "implementar login", objective: "ter login funcionando", decisions: ["usar sessão"], constraints: ["sem dependência"], next_steps: ["testar"] });
const usage = (l: Ledger, run: string) => l.record({ run, agent: "planner", provider: "openai", model: "gpt-4o-mini", credentialRef: "K", quotaDomain: "d", tokensIn: 10, tokensOut: 5, callHashes: [] });

describe("compactação do handoff (F-25)", () => {
  test("ordem de truncamento: open_questions antes de decisions; task/objective/next_steps nunca", () => {
    const small = compactDraft(draft(), 512);
    expect(small.compaction).toEqual({ strategy: "none", droppedFields: [] });
    expect(small.truncated).toBe(false);
    expect(small.originalTokens).toBe(small.returnedTokens);
    const withOpen = { ...draft(), open_questions: [big(400)] };
    const onlyOpen = compactDraft(withOpen, 40);
    expect(onlyOpen.compaction).toEqual({ strategy: "truncate", droppedFields: ["open_questions"] });
    expect(onlyOpen.truncated).toBe(true);
    expect(onlyOpen.draft.task).toBe("implementar login");
    expect(onlyOpen.originalTokens).toBeGreaterThan(onlyOpen.returnedTokens);
    const both = compactDraft({ ...withOpen, decisions: [big(400), big(400)] }, 40);
    expect(both.compaction).toEqual({ strategy: "truncate", droppedFields: ["open_questions", "decisions"] });
    expect(both.draft.decisions).toEqual([]);
    const onlyDecisions = compactDraft({ ...draft(), decisions: [big(400), big(400), big(400)] }, 40);
    expect(onlyDecisions.compaction).toEqual({ strategy: "truncate", droppedFields: ["decisions"] });
    expect(onlyDecisions.draft.next_steps).toEqual(["testar"]); // nunca cortado
    const never = compactDraft({ task: big(400), objective: big(400), decisions: [], constraints: [], next_steps: [big(400)] }, 1);
    expect(never.draft.task).toBe(big(400)); // permanece mesmo fora do orçamento
  });

  test("digestArtifacts calcula dentro do cwd e validateArtifacts rejeita divergência (I-11)", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "arte.txt"), "conteúdo do artefato");
    const refs = digestArtifacts(cwd, ["arte.txt"]);
    expect(refs[0]!.digest).toBe(sha("conteúdo do artefato"));
    validateArtifacts(cwd, refs); // digest bate
    writeFileSync(join(cwd, "arte.txt"), "conteúdo alterado");
    const diverged = (() => { try { validateArtifacts(cwd, refs); } catch (e) { return e as HandoffError; } })();
    expect(diverged?.code).toBe("handoff_artifact_mismatch");
    expect(diverged?.retryable).toBe(false);
    const missing = (() => { try { validateArtifacts(cwd, [{ path: "sumiu.txt", digest: refs[0]!.digest }]); } catch (e) { return e as HandoffError; } })();
    expect(missing?.code).toBe("handoff_artifact_mismatch");
    const outside = (() => { try { validateArtifacts(cwd, [{ path: "..\\arte.txt", digest: refs[0]!.digest }]); } catch (e) { return e as HandoffError; } })();
    expect(outside?.code).toBe("handoff_artifact_mismatch");
    expect(() => digestArtifacts(cwd, ["../fora.txt"])).toThrow(/fora do diretório/);
  });

  test("ledger ganha seq monotônico, id estável e leitura por intervalo", () => {
    const path = join(dir(), "ledger.jsonl");
    const ledger = new Ledger(path);
    usage(ledger, "r1"); usage(ledger, "r1"); usage(ledger, "r2");
    const seqs = ledger.readSeqRange(1, 3).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(ledger.readSeqRange(2, 2)).toHaveLength(1);
    expect(ledger.seqBoundsOfRun("r1")).toEqual({ start: 1, end: 2 });
    expect(ledger.seqBoundsOfRun("r2")).toEqual({ start: 3, end: 3 });
    expect(ledger.seqBoundsOfRun("rx")).toBeUndefined();
    const reopened = new Ledger(path);
    usage(reopened, "r1");
    expect(reopened.readSeqRange(4, 4)).toHaveLength(1); // continua a numeração
    expect(reopened.id()).toBe(ledger.id()); // id estável por caminho
    expect(new Ledger(join(dir(), "ledger.jsonl")).id()).not.toBe(ledger.id());
  });

  test("artefato v1 carrega source_refs, artifacts, compaction e truncamento validados", () => {
    const artifact = buildHandoffArtifact({
      run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 10, usd: 0 },
      draft: { ...draft(), open_questions: ["quem valida?"] },
      sourceRefs: { ledger_id: sha("ledger"), seq_start: 1, seq_end: 3 },
      artifacts: [{ path: "arte.txt", digest: sha("conteúdo") }],
      compaction: { strategy: "truncate", droppedFields: ["open_questions"] },
      truncation: { truncated: true, originalTokens: 120, returnedTokens: 30 },
    });
    expect(artifact.source_refs).toEqual({ ledger_id: sha("ledger"), seq_start: 1, seq_end: 3 });
    expect(artifact.compaction).toEqual({ strategy: "truncate", droppedFields: ["open_questions"] });
    expect(artifact.truncated).toBe(true);
    expect(artifact.open_questions).toEqual(["quem valida?"]);
    expect(validateHandoffArtifact(artifact)).toEqual(artifact);
    expect(() => validateHandoffArtifact({ ...artifact, compaction: { strategy: "resumo", droppedFields: [] } })).toThrow(HandoffError);
    expect(() => validateHandoffArtifact({ ...artifact, artifacts: [{ path: "a", digest: "zz" }] })).toThrow(HandoffError);
    expect(() => validateHandoffArtifact({ ...artifact, source_refs: { ledger_id: "l", seq_start: 0, seq_end: 2 } })).toThrow(HandoffError);
    expect(() => validateHandoffArtifact({ ...artifact, truncated: true, originalTokens: -1, returnedTokens: 1 })).toThrow(HandoffError);
    // compactação não altera o id: id depende só de run/from/to/taskHash/source_step
    const compactedId = handoffId(buildHandoffArtifact({ run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 }, draft: { ...draft(), decisions: [] }, compaction: { strategy: "truncate", droppedFields: ["decisions"] } }));
    expect(compactedId).toBe(handoffId(buildHandoffArtifact({ run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 }, draft: draft() })));
  });

  test("sanitize redige path e open_questions sem quebrar o id (I-03)", () => {
    const NV = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
    const artifact = buildHandoffArtifact({
      run: "r1", from: "planner", to: "coder", sourceStep: 1, budgetSpent: { tokens: 0, usd: 0 },
      draft: { ...draft(), open_questions: [`duvida ${NV}`] },
      artifacts: [{ path: `arquivo-${NV}.txt`, digest: sha("x") }],
    });
    const safe = sanitizeHandoffArtifact(artifact);
    const raw = JSON.stringify(safe);
    expect(raw).not.toContain(NV);
    expect(raw).toContain("[REDACTED]");
    expect(safe.artifacts![0]!.digest).toBe(sha("x")); // digest intacto
    expect(handoffId(safe)).toBe(handoffId(artifact)); // id não depende dos campos redigidos
    const ledgerPath = join(dir(), "ledger.jsonl");
    const stored = new Ledger(ledgerPath).recordHandoff("handoff.created", "r1", artifact, { agent: "planner" });
    expect(readFileSync(ledgerPath, "utf8")).not.toContain(NV);
    expect(stored.artifact.compaction).toEqual({ strategy: "none", droppedFields: [] });
  });
});
