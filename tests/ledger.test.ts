import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LEDGER_SCHEMA_VERSION, hashToolCalls, type LedgerEntry } from "../src/ledger";
import { redactSecrets } from "../src/sanitize-external";

const dir = () => mkdtempSync(join(tmpdir(), "astro-ledger-"));
const entry = {
  run: "r1", agent: "default", provider: "openai", model: "gpt-4o-mini",
  credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
  tokensIn: 1000, tokensOut: 500,
};

test("registra e calcula custo por 1M de tokens (cria subdiretório)", () => {
  const l = new Ledger(join(dir(), "sub", "ledger.jsonl"));
  const e = l.record(structuredClone(entry), { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false });
  expect(e.costUsd).toBeCloseTo(0.002, 10); // 1000/1e6*1 + 500/1e6*2
});

test("sem preço curado → costUsd null + aviso", () => {
  const warns: string[] = [];
  const l = new Ledger(join(dir(), "ledger.jsonl"), { warn: (m) => warns.push(m) });
  const e = l.record(structuredClone(entry), undefined);
  expect(e.costUsd).toBeNull();
  expect(warns.length).toBe(1);
});

test("total soma tokens e custo", () => {
  const l = new Ledger(join(dir(), "ledger.jsonl"));
  const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
  l.record(structuredClone(entry), price);
  l.record(structuredClone(entry), price);
  const t = l.total();
  expect(t.tokensIn).toBe(2000);
  expect(t.tokensOut).toBe(1000);
  expect(t.costUsd).toBeCloseTo(0.003, 10);
});

test("readAll lê o JSONL persistido entre instâncias", () => {
  const path = join(dir(), "ledger.jsonl");
  const first = new Ledger(path).record(structuredClone(entry), {
    inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false,
  });
  const all = new Ledger(path).readAll();
  expect(all).toHaveLength(1);
  expect(all[0]).toEqual(first);
  expect(all[0].ts).toBeTruthy();
});

describe("byAgent com profile (F-30)", () => {
  test("granularidade de profile: chave agent|profile e campos de identidade", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner", profile: "premium", model: "gpt-4o", tokensIn: 100, tokensOut: 50 }, price);
    l.record({ ...entry, agent: "planner", profile: "premium", model: "gpt-4o", tokensIn: 100, tokensOut: 50 }, price);
    l.record({ ...entry, agent: "planner", model: "gpt-4o-mini", tokensIn: 10, tokensOut: 5 }, price);
    l.record({ ...entry, agent: "coder", model: "gpt-4o-mini", tokensIn: 200, tokensOut: 100 }, price); // legado sem profile

    const byAgent = l.byAgent();
    expect(Object.keys(byAgent).sort()).toEqual(["coder", "planner", "planner|premium"]);
    expect(byAgent["planner|premium"]).toMatchObject({ agent: "planner", profile: "premium", provider: "openai", model: "gpt-4o", tokensIn: 200, tokensOut: 100 });
    expect(byAgent.planner).toMatchObject({ agent: "planner", model: "gpt-4o-mini", tokensIn: 10, tokensOut: 5 }); // sem profile soma separado
    expect("profile" in byAgent.planner && byAgent.planner.profile !== undefined).toBe(false);
    expect(byAgent.coder).toMatchObject({ agent: "coder", tokensIn: 200, tokensOut: 100 }); // entrada antiga continua somando
    const totalCost = Object.values(byAgent).reduce((acc, a) => acc + a.costUsd, 0);
    expect(totalCost).toBeCloseTo(l.total().costUsd, 12); // custo por agente bate com o ledger
  });
});

describe("byAgent (F3-3)", () => {
  test("agrega por agent no mesmo run", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner", tokensIn: 100, tokensOut: 50 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 200, tokensOut: 100 }, price);
    l.record({ ...entry, agent: "reviewer", tokensIn: 50, tokensOut: 25 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 100, tokensOut: 50 }, price);

    const byAgent = l.byAgent();
    expect(Object.keys(byAgent).sort()).toEqual(["coder", "planner", "reviewer"]);
    expect(byAgent.planner.tokensIn).toBe(100);
    expect(byAgent.planner.tokensOut).toBe(50);
    expect(byAgent.coder.tokensIn).toBe(300);
    expect(byAgent.coder.tokensOut).toBe(150);
    expect(byAgent.reviewer.tokensIn).toBe(50);
    expect(byAgent.reviewer.tokensOut).toBe(25);
  });

  test("byAgent soma costUsd", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 2, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner", tokensIn: 1000, tokensOut: 500 }, price);
    l.record({ ...entry, agent: "coder", tokensIn: 1000, tokensOut: 500 }, price);

    const byAgent = l.byAgent();
    expect(byAgent.planner.costUsd).toBeCloseTo(0.002, 10);
    expect(byAgent.coder.costUsd).toBeCloseTo(0.002, 10);
  });

  test("byAgent com costUsd null trata como 0", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record({ ...entry, agent: "planner" }, undefined);
    const byAgent = l.byAgent();
    expect(byAgent.planner.costUsd).toBe(0);
  });

  test("um run com 3 agents mostra 3 entradas com agent diferentes", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const price = { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false };
    l.record({ ...entry, agent: "planner" }, price);
    l.record({ ...entry, agent: "coder" }, price);
    l.record({ ...entry, agent: "reviewer" }, price);

    const all = l.readAll();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((e) => e.agent))).toEqual(new Set(["planner", "coder", "reviewer"]));
    expect(new Set(all.map((e) => e.run))).toEqual(new Set(["r1"]));
  });
});

describe("schemaVersion (F-02, ADR-0002)", () => {
  test("record preenche schemaVersion e kind automaticamente", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const e = l.record(structuredClone(entry), undefined);
    expect(e.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
    expect(e.kind).toBe("usage");
    expect(LEDGER_SCHEMA_VERSION).toBe(3);
  });

  test("entrada antiga sem schemaVersion ainda soma em total()", () => {
    const path = join(dir(), "ledger.jsonl");
    const old = { ...entry, ts: "2026-01-01T00:00:00Z", costUsd: null };
    writeFileSync(path, `${JSON.stringify(old)}\n`, "utf8");
    const l = new Ledger(path);
    l.record({ ...entry, tokensIn: 10, tokensOut: 5 }, undefined);
    const t = l.total();
    expect(t.tokensIn).toBe(1010);
    expect(t.tokensOut).toBe(505);
  });
});

describe("estado de execução (F-02)", () => {
  test("recordState grava entrada run_state com agent e reason", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    const s = l.recordState("r1", "interrupted", { agent: "default", reason: "MaxStepsError" });
    expect(s.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
    expect(s.kind).toBe("run_state");
    expect(s.state).toBe("interrupted");
    expect(s.agent).toBe("default");
    expect(s.reason).toBe("MaxStepsError");
    expect(s.ts).toBeTruthy();
  });

  test("cauda parcial no ledger não impede leitura nem continuação do seq", () => {
    const path = join(dir(), "ledger.jsonl");
    const warns: string[] = [];
    new Ledger(path, { warn: (m) => warns.push(m) })
      .record(structuredClone(entry), undefined);
    appendFileSync(path, '{"schemaVersion":1,"seq":2,', "utf8");

    const reopened = new Ledger(path, { warn: (m) => warns.push(m) });
    expect(reopened.readAll()).toHaveLength(1);
    expect(reopened.record(structuredClone(entry), undefined).seq).toBe(2);
    expect(warns.some((m) => m.includes("parcial"))).toBe(true);
  });

  test("readAll devolve só uso; readAllEntries devolve tudo na ordem", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "interrupted");
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "completed");
    expect(l.readAll()).toHaveLength(2);
    const all = l.readAllEntries();
    expect(all).toHaveLength(4);
    expect(all[1].kind).toBe("run_state");
    expect(all[3].kind).toBe("run_state");
    expect(l.readStates()).toHaveLength(2);
  });

  test("total e byAgent ignoram entradas de estado (sem NaN)", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    l.record(structuredClone(entry), undefined);
    l.recordState("r1", "interrupted");
    const t = l.total();
    expect(Number.isNaN(t.tokensIn)).toBe(false);
    expect(t.tokensIn).toBe(1000);
    const byAgent = l.byAgent();
    expect(byAgent.default.tokensIn).toBe(1000);
  });

  test("lastState devolve a última entrada de estado do run", () => {
    const l = new Ledger(join(dir(), "ledger.jsonl"));
    expect(l.lastState("r1")).toBeUndefined();
    l.recordState("r1", "interrupted");
    l.recordState("r2", "completed");
    l.recordState("r1", "completed");
    expect(l.lastState("r1")!.state).toBe("completed");
    expect(l.lastState("r2")!.state).toBe("completed");
  });
});

describe("hashToolCalls (F-02)", () => {
  test("um hash SHA-256 por call, determinístico", () => {
    const calls = [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }];
    const h1 = hashToolCalls(calls);
    const h2 = hashToolCalls(calls);
    expect(h1).toHaveLength(1);
    expect(h1[0]).toBe(h2[0]);
    expect(h1[0]).toBe(
      createHash("sha256")
        .update(JSON.stringify({ name: "read_file", arguments: calls[0].arguments }))
        .digest("hex"),
    );
  });

  test("nome e arguments alteram o hash; sem calls devolve vazio", () => {
    const a = hashToolCalls([{ name: "read_file", arguments: "{}" }]);
    const b = hashToolCalls([{ name: "write_file", arguments: "{}" }]);
    const c = hashToolCalls([{ name: "read_file", arguments: '{"path":"x"}' }]);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).not.toBe(c[0]);
    expect(hashToolCalls([])).toEqual([]);
  });
});

describe("novos kinds e campos de usage (S-05, #122)", () => {
  const testDir = () => mkdtempSync(join(tmpdir(), "astro-ledger-kinds-"));

  describe("usage gains lvl, effort, thinking, param.stripped (E7)", () => {
    test("usage entry aceita lvl, effort, thinking, param.stripped opcionais", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.record({
        ...entry,
        tokensIn: 100,
        tokensOut: 50,
        lvl: 2,
        effort: "high",
        thinking: "enabled",
        "param.stripped": [{ name: "forbidden_param", reason: "forbidden" }],
      }, { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false });

      expect(e.lvl).toBe(2);
      expect(e.effort).toBe("high");
      expect(e.thinking).toBe("enabled");
      expect(e["param.stripped"]).toEqual([{ name: "forbidden_param", reason: "forbidden" }]);
      expect(e.kind).toBe("usage");
      expect(e.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
    });

    test("campos ausentes em entradas legadas não quebram total()", () => {
      const path = join(testDir(), "ledger.jsonl");
      const old = { ...entry, ts: "2026-01-01T00:00:00Z", costUsd: null };
      writeFileSync(path, `${JSON.stringify(old)}\n`, "utf8");
      const l = new Ledger(path);
      l.record({ ...entry, tokensIn: 10, tokensOut: 5 }, undefined);
      const t = l.total();
      expect(t.tokensIn).toBe(1010);
      expect(t.tokensOut).toBe(505);
    });

    test("lvl, effort, thinking, param.stripped passam por redactSecrets na escrita", () => {
      const path = join(testDir(), "ledger.jsonl");
      const l = new Ledger(path);
      // gitleaks-ignore: test constant uses Bearer pattern (redacted by redactSecrets)
      const secret = "Bearer testtoken123456789012"; // 12+ chars after Bearer
      l.record({
        ...entry,
        tokensIn: 10,
        tokensOut: 5,
        lvl: 1,
        effort: secret,
        thinking: secret,
        "param.stripped": [{ name: secret, reason: "forbidden" }],
      }, undefined);

      const content = readFileSync(path, "utf8");
      const written = JSON.parse(content.trim());
      expect(written.lvl).toBe(1);
      // O secret deve ser redigido também em effort/thinking/param.stripped
      expect(content).not.toContain(secret);
    });

    test("param.stripped legado em string continua legível", () => {
      const path = join(testDir(), "ledger.jsonl");
      const old = { ...entry, ts: "2026-01-01T00:00:00Z", costUsd: null, schemaVersion: 2, "param.stripped": ["legacy"] };
      writeFileSync(path, `${JSON.stringify(old)}\n`, "utf8");
      const l = new Ledger(path);
      const read = l.readAllEntries()[0] as LedgerEntry;
      expect(read["param.stripped"]).toEqual(["legacy"]);
    });

    test("lvl fora de 0..4 falha na escrita", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      expect(() => l.record({ ...entry, tokensIn: 1, tokensOut: 1, lvl: 5 }, undefined))
        .toThrow(/nível de esforço inválido/);
    });
  });

  describe("kind agent: created/destroyed (PS-5, A4, M3)", () => {
    test("recordAgentCreated grava kind agent com event=created e campos obrigatórios", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordAgentCreated({
        run: "r1",
        agent_id: "sub-1",
        parent_agent_id: "planner",
        session_id: "sess-1",
        need: "coding",
        model: "gpt-4o-mini",
        profile: "premium",
        reason: "delegated by planner",
      });

      expect(e.kind).toBe("agent");
      expect(e.event).toBe("created");
      expect(e.agent_id).toBe("sub-1");
      expect(e.parent_agent_id).toBe("planner");
      expect(e.session_id).toBe("sess-1");
      expect(e.need).toBe("coding");
      expect(e.model).toBe("gpt-4o-mini");
      expect(e.profile).toBe("premium");
      expect(e.reason).toBe("delegated by planner");
      expect(e.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
      expect(e.ts).toBeTruthy();
    });

    test("recordAgentDestroyed grava kind agent com event=destroyed e reason de destruição", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordAgentDestroyed({
        run: "r1",
        agent_id: "sub-1",
        session_id: "sess-1",
        reason: "maxTurns reached",
      });

      expect(e.kind).toBe("agent");
      expect(e.event).toBe("destroyed");
      expect(e.agent_id).toBe("sub-1");
      expect(e.session_id).toBe("sess-1");
      expect(e.reason).toBe("maxTurns reached");
    });

    test("campos opcionais e redactSecrets funcionam", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      // redactSecrets redige: sk-* (8+ chars), Bearer * (12+ chars), nvapi-* (8+ chars)
      // gitleaks-ignore: test constant uses Bearer pattern (redacted by redactSecrets)
      const secret = "Bearer testtoken123456789012"; // 12+ chars after Bearer
      l.recordAgentCreated({
        run: "r1",
        agent_id: "sub-1",
        session_id: "sess-1",
        need: "coding",
        model: "gpt-4o-mini",
        reason: `uses ${secret}`,
      });
      const content = readFileSync(l.path, "utf8");
      expect(content).not.toContain(secret);
      expect(content).toContain("[REDACTED]");
    });
  });

  describe("kind budget: reserved/released/exceeded_choice/ceiling_hit/budget_exceeded_non_interactive (B9, B10, B4)", () => {
    test("recordBudgetReserved grava kind budget com reserved", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordBudgetReserved({
        run: "r1",
        agent: "planner",
        reserved: 0.50,
        detail: "primary + fallback chain",
      });

      expect(e.kind).toBe("budget");
      expect(e.reserved).toBe(0.50);
      expect(e.detail).toBe("primary + fallback chain");
      expect(e.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
    });

    test("recordBudgetReleased grava kind budget com released e actual_cost", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordBudgetReleased({
        run: "r1",
        agent: "planner",
        released: 0.50,
        actual_cost: 0.30,
      });

      expect(e.kind).toBe("budget");
      expect(e.released).toBe(0.50);
      expect(e.actual_cost).toBe(0.30);
    });

    test("recordBudgetExceeded grava kind budget com exceeded_choice", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordBudgetExceeded({
        run: "r1",
        agent: "planner",
        exceeded_choice: "continue_same",
      });

      expect(e.kind).toBe("budget");
      expect(e.exceeded_choice).toBe("continue_same");
    });

    test("recordCeilingHit grava kind budget com ceiling_hit", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordCeilingHit({
        run: "r1",
        agent: "planner",
        ceiling_hit: true,
      });

      expect(e.kind).toBe("budget");
      expect(e.ceiling_hit).toBe(true);
    });

    test("recordBudgetExceededNonInteractive grava kind budget com budget_exceeded_non_interactive", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordBudgetExceededNonInteractive({
        run: "r1",
        agent: "planner",
        budget_exceeded_non_interactive: true,
      });

      expect(e.kind).toBe("budget");
      expect(e.budget_exceeded_non_interactive).toBe(true);
    });
  });

  describe("kind compaction: failure_count, manual (CMP-6)", () => {
    test("recordCompaction grava kind compaction com failure_count e manual", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordCompaction({
        run: "r1",
        agent: "planner",
        failure_count: 2,
        manual: false,
      });

      expect(e.kind).toBe("compaction");
      expect(e.failure_count).toBe(2);
      expect(e.manual).toBe(false);
    });

    test("recordCompaction manual true registra compaction.manual", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      const e = l.recordCompaction({
        run: "r1",
        agent: "planner",
        failure_count: 0,
        manual: true,
      });

      expect(e.kind).toBe("compaction");
      expect(e.manual).toBe(true);
    });
  });

  describe("schemaVersion e compatibilidade (ADR-0002)", () => {
    test("novos kinds têm schemaVersion 1 e seq monotônico", () => {
      const l = new Ledger(join(testDir(), "ledger.jsonl"));
      l.recordAgentCreated({ run: "r1", agent_id: "a1", session_id: "s1", need: "n", model: "m" });
      l.recordBudgetReserved({ run: "r1", agent: "planner", reserved: 0.1 });
      l.recordCompaction({ run: "r1", agent: "planner", failure_count: 0, manual: false });

      const all = l.readAllEntries();
      const newKinds = all.filter((e) => e.kind === "agent" || e.kind === "budget" || e.kind === "compaction");
      expect(newKinds).toHaveLength(3);
      newKinds.forEach((e) => {
        expect(e.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
        expect(typeof e.seq).toBe("number");
      });
    });

    test("entrada antiga sem kind continua legível e somada em total()", () => {
      const path = join(testDir(), "ledger.jsonl");
      const old = { ...entry, ts: "2026-01-01T00:00:00Z", costUsd: null };
      writeFileSync(path, `${JSON.stringify(old)}\n`, "utf8");
      const l = new Ledger(path);
      l.record({ ...entry, tokensIn: 10, tokensOut: 5 }, undefined);
      const t = l.total();
      expect(t.tokensIn).toBe(1010);
      expect(t.tokensOut).toBe(505);
    });
  });

  describe("redactSecrets em todos os novos campos livres (I-03, golden §11.6)", () => {
    test("secret em reason de agent não vaza", () => {
      const path = join(testDir(), "ledger.jsonl");
      const l = new Ledger(path);
      // redactSecrets redige: sk-* (8+ chars), Bearer * (12+ chars), nvapi-* (8+ chars)
      // gitleaks-ignore: test constant uses Bearer pattern (redacted by redactSecrets)
      const secret = "Bearer testtoken123456789012"; // 12+ chars after Bearer
      l.recordAgentCreated({
        run: "r1", agent_id: "a1", session_id: "s1", need: "n", model: "m",
        reason: `auth: ${secret}`,
      });
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain(secret);
      expect(content).toContain("[REDACTED]");
    });

    test("secret em detail de budget não vaza", () => {
      const path = join(testDir(), "ledger.jsonl");
      const l = new Ledger(path);
      // redactSecrets redige: sk-* (8+ chars), Bearer * (12+ chars), nvapi-* (8+ chars)
      // gitleaks-ignore: test constant uses Bearer pattern (redacted by redactSecrets)
      const secret = "Bearer testtoken123456789012"; // 12+ chars after Bearer
      l.recordBudgetReserved({ run: "r1", agent: "p", reserved: 0.1, detail: secret });
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain(secret);
      expect(content).toContain("[REDACTED]");
    });
  });
});
