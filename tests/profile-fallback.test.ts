import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { AccountLockedError, type AgentLock } from "../src/agent-lock";
import { ProfileFallbackProvider, type ProfileChainEntry } from "../src/provider/profile-fallback-provider";
import { ProviderError, type CompletionRequest, type CompletionResponse, type Provider } from "../src/provider/types";

const resp = (content: string, provider?: string): CompletionResponse => ({
  content,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  ...(provider === undefined ? {} : { provider }),
});

const req = (profile?: string): CompletionRequest => ({
  model: "modelo-pedido",
  messages: [{ role: "user", content: "x" }],
  ...(profile === undefined ? {} : { profile }),
});
const auditOf = () => new Auditor(join(mkdtempSync(join(tmpdir(), "astro-f31b-")), "audit.jsonl"));

/** Profile de teste com provider controlado; `fallback` declara a cadeia. */
function entry(
  name: string,
  provider: string,
  model: string,
  fallback: string[],
  complete: Provider["complete"],
  credentialRef?: string,
  accountRef?: string,
): ProfileChainEntry {
  return {
    name, provider, model, fallback,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(accountRef === undefined ? {} : { accountRef }),
    create: () => ({ complete }),
  };
}

const holder = (accountRef: string): AgentLock => ({
  run: "other", agent_id: "holder", session_id: "other", accountRef, seq: 1,
});

describe("ProfileFallbackProvider (F-31)", () => {
  test("primário em outage cai para o próximo profile, reescreve o model e devolve a trilha", async () => {
    const calls: string[] = [];
    const requests: CompletionRequest[] = [];
    const audit = auditOf();
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("primario", "a", "m1", ["backup"], async () => {
          calls.push("primario");
          throw new ProviderError("outage", "a fora");
        }),
        entry("backup", "b", "m2", [], async (r) => {
          calls.push("backup");
          requests.push(r);
          return resp("do-backup");
        }),
      ],
      audit,
      run: "r1",
    });

    const out = await fb.complete(req("primario"));
    expect(calls).toEqual(["primario", "backup"]);
    expect(requests.map((r) => r.model)).toEqual(["m2"]); // model do profile, não o pedido
    expect(out).toMatchObject({
      content: "do-backup",
      provider: "b",
      fallbacks: [{ profile: "primario", from_provider: "a", to_provider: "b", reason: "outage" }],
    });
    const events = audit.readAll();
    expect(events.find((e) => e.tipo === "profile.failure")!.payload).toMatchObject({
      profile: "primario",
      provider: "a",
      errorClass: "outage",
    });
    expect(events.find((e) => e.tipo === "profile.fallback")!.payload).toEqual({
      profile: "primario",
      from_provider: "a",
      to_provider: "b",
      reason: "outage",
    });
  });

  test("preserva o model efetivo devolvido pelo provider", async () => {
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [entry("p1", "a", "m1", [], async () => ({ ...resp("ok"), model: "real-x" }))],
    });
    expect((await fb.complete(req("p1"))).model).toBe("real-x");
  });

  test("hard_quota pula o profile; auth e invalid_request abortam sem tentar fallback", async () => {
    const quotaCalls: string[] = [];
    const quota = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2"], async () => {
          quotaCalls.push("p1");
          throw new ProviderError("hard_quota", "cota dura");
        }),
        entry("p2", "b", "m2", [], async () => {
          quotaCalls.push("p2");
          return resp("ok");
        }),
      ],
    });
    expect((await quota.complete(req("p1"))).content).toBe("ok");
    expect(quotaCalls).toEqual(["p1", "p2"]);

    for (const errClass of ["auth", "invalid_request"] as const) {
      const calls: string[] = [];
      const audit = auditOf();
      const fb = new ProfileFallbackProvider({
        base: { complete: async () => resp("base") },
        profiles: [
          entry("p1", "a", "m1", ["p2"], async () => {
            calls.push("p1");
            throw new ProviderError(errClass, "não adianta");
          }),
          entry("p2", "b", "m2", [], async () => {
            calls.push("p2");
            return resp("não deveria");
          }),
        ],
        audit,
        run: "r1",
      });
      const error = (await fb.complete(req("p1")).then(() => null, (e) => e)) as ProviderError;
      expect(error.errClass).toBe(errClass);
      expect(calls).toEqual(["p1"]); // abortou antes do fallback
      expect(audit.readAll().some((e) => e.tipo === "profile.fallback")).toBe(false);
    }
  });

  test("sem profile usa o base sem reescrever model; fallback vazio mantém o comportamento atual", async () => {
    const baseReqs: CompletionRequest[] = [];
    const fb = new ProfileFallbackProvider({
      base: { complete: async (r) => { baseReqs.push(r); return resp("base"); } },
      profiles: [entry("p1", "a", "m1", [], async () => { throw new ProviderError("outage", "a fora"); })],
    });
    expect((await fb.complete(req())).content).toBe("base");
    expect(baseReqs[0]!.model).toBe("modelo-pedido");
    const error = (await fb.complete(req("p1")).then(() => null, (e) => e)) as ProviderError;
    expect(error.errClass).toBe("outage");
    expect(baseReqs).toHaveLength(1);
  });

  test("cadeia transitiva segue a ordem declarada e deduplica profile repetido", async () => {
    const calls: string[] = [];
    const ok = (name: string, model: string, fallback: string[] = []): ProfileChainEntry =>
      entry(name, name, model, fallback, async () => { calls.push(name); return resp(`de-${name}`); });
    const fail = (name: string, model: string, fallback: string[]): ProfileChainEntry =>
      entry(name, name, model, fallback, async () => { calls.push(name); throw new ProviderError("outage", `${name} fora`); });
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [fail("p1", "m1", ["p2", "p3"]), fail("p2", "m2", ["p3"]), ok("p3", "m3")],
    });
    const out = await fb.complete(req("p1"));
    expect(calls).toEqual(["p1", "p2", "p3"]); // p3 já visitado não repete
    expect(out.fallbacks).toEqual([
      { profile: "p1", from_provider: "p1", to_provider: "p2", reason: "outage" },
      { profile: "p2", from_provider: "p2", to_provider: "p3", reason: "outage" },
    ]);
  });

  test("falha de fábrica e erro não classificado pulam o profile sem abortar", async () => {
    const calls: string[] = [];
    const audit = auditOf();
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2"], async () => { calls.push("p1"); throw new ProviderError("outage", "a fora"); }),
        { name: "p2", provider: "b", model: "m2", fallback: ["p3"], create: () => { throw new Error("defina KEY_B no ambiente"); } },
        entry("p3", "c", "m3", [], async () => { calls.push("p3"); return resp("de-p3"); }),
      ],
      audit,
      run: "r1",
    });
    const out = await fb.complete(req("p1"));
    expect(out.content).toBe("de-p3");
    expect(calls).toEqual(["p1", "p3"]);
    expect(out.fallbacks!.map((f) => f.reason)).toEqual(["outage", "invalid_request"]);
    expect(audit.readAll().find((e) => e.tipo === "profile.failure" && e.payload.profile === "p2")!.payload).toMatchObject({
      provider: "b",
      errorClass: "invalid_request",
    });
  });

  test("profile desconhecido falha com mensagem clara e não chama o base", async () => {
    let baseCalls = 0;
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => { baseCalls++; return resp("base"); } },
      profiles: [],
    });
    const error = (await fb.complete(req("ghost")).then(() => null, (e) => e)) as ProviderError;
    expect(error.errClass).toBe("invalid_request");
    expect(error.message).toContain("ghost");
    expect(baseCalls).toBe(0);
  });

  test("profile saudável não devolve trilha de fallback", async () => {
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [entry("p1", "a", "m1", ["p2"], async () => resp("ok"))],
    });
    const out = await fb.complete(req("p1"));
    expect(out.content).toBe("ok");
    expect("fallbacks" in out).toBe(false);
  });

  test("destino com conta ocupada é pulado, sem entrar na trilha (A7)", async () => {
    const audit = auditOf();
    const calls: string[] = [];
    const moved: string[] = [];
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2", "p3"], async () => { calls.push("p1"); throw new ProviderError("outage", "a fora"); }, "KEY_A"),
        entry("p2", "b", "m2", ["p3"], async () => { calls.push("p2"); return resp("p2"); }, "KEY_B"),
        entry("p3", "c", "m3", [], async () => { calls.push("p3"); return resp("p3"); }, "KEY_C"),
      ],
      audit,
      run: "r1",
      moveAccount: (target) => {
        if (target.name === "p2") throw new AccountLockedError("KEY_B", holder("KEY_B"));
        moved.push(target.credentialRef ?? "");
      },
    });

    const out = await fb.complete(req("p1"));
    expect(calls).toEqual(["p1", "p3"]);
    expect(moved).toEqual(["KEY_C"]);
    expect(out.fallbacks).toEqual([
      { profile: "p1", from_provider: "a", to_provider: "c", reason: "outage" },
    ]);
    const skipped = audit.readAll().find((e) => e.tipo === "profile.fallback_skipped");
    expect(skipped?.payload).toMatchObject({ profile: "p2", provider: "b", errorClass: "account_locked" });
  });

  test("após fallback, o próximo completion continua no profile que atendeu (A4)", async () => {
    const calls: string[] = [];
    let p1Calls = 0;
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2"], async () => {
          calls.push("p1");
          p1Calls++;
          if (p1Calls === 1) throw new ProviderError("outage", "a fora");
          return resp("p1");
        }),
        entry("p2", "b", "m2", [], async () => { calls.push("p2"); return resp("p2"); }),
      ],
    });
    expect((await fb.complete(req("p1"))).content).toBe("p2");
    expect((await fb.complete(req("p1"))).content).toBe("p2");
    expect(calls).toEqual(["p1", "p2", "p2"]);
  });

  test("sticky de profile não vaza para outro agente com a conta primária", async () => {
    let current = "KEY_A";
    const calls: string[] = [];
    let p1Calls = 0;
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2"], async () => {
          calls.push("p1");
          p1Calls++;
          if (p1Calls === 1) throw new ProviderError("outage", "a fora");
          return resp("p1");
        }, "KEY_A", "KEY_A"),
        entry("p2", "b", "m2", [], async () => { calls.push("p2"); return resp("p2"); }, "KEY_B", "KEY_B"),
      ],
      currentAccount: () => current,
      moveAccount: (target) => { current = target.accountRef ?? current; },
    });

    expect((await fb.complete(req("p1"))).content).toBe("p2");
    expect(current).toBe("KEY_B");
    expect((await fb.complete(req("p1"))).content).toBe("p2"); // mesmo agente, sticky
    current = "KEY_A"; // handoff: novo agente adquiriu a conta primária
    expect((await fb.complete(req("p1"))).content).toBe("p1");
    expect(calls).toEqual(["p1", "p2", "p2", "p1"]);
  });

  test("destino ocupado é pulado antes do gate de aprovação (A7)", async () => {
    const calls: string[] = [];
    const approvals: string[] = [];
    const fb = new ProfileFallbackProvider({
      base: { complete: async () => resp("base") },
      profiles: [
        entry("p1", "a", "m1", ["p2", "p3"], async () => { calls.push("p1"); throw new ProviderError("outage", "a"); }, "KEY_A", "KEY_A"),
        entry("p2", "b", "m2", ["p3"], async () => { calls.push("p2"); return resp("p2"); }, "KEY_B", "KEY_B"),
        entry("p3", "c", "m3", [], async () => { calls.push("p3"); return resp("p3"); }, "KEY_C", "KEY_C"),
      ],
      canUseAccount: (entry) => entry.name !== "p2",
      approveSwap: async (request) => { approvals.push(request.to.profile ?? ""); return true; },
    });

    expect((await fb.complete(req("p1"))).content).toBe("p3");
    expect(calls).toEqual(["p1", "p3"]);
    expect(approvals).toEqual(["p3"]);
  });
});
