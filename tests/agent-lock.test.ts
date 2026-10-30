import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountLockedError,
  accountRefOf,
  acquireAgentLock,
  activeLocks,
  recoverCrashedAgents,
  releaseAgentLock,
} from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { assertWithinQuota } from "../src/quota";

function setup(): { ledger: Ledger; audit: Auditor } {
  const dir = mkdtempSync(join(tmpdir(), "astro-lock-"));
  return { ledger: new Ledger(join(dir, "ledger.jsonl")), audit: new Auditor(join(dir, "audit.jsonl")) };
}

describe("lock exclusivo de conta por agente ativo (A4, PS-5)", () => {
  test("adquire a conta com agent.created e audit agent.lock.acquired sem valor de segredo", () => {
    const { ledger, audit } = setup();

    const lock = acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      model: "m1",
      credentialRef: "NVIDIA_API_KEY",
    });

    expect(lock.accountRef).toBe("NVIDIA_API_KEY");
    expect(activeLocks(ledger)).toHaveLength(1);
    const created = ledger.readAllEntries().filter((e) => e.kind === "agent");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      event: "created",
      agent_id: "planner",
      credentialRef: "NVIDIA_API_KEY",
    });

    const acquired = audit.readAll().filter((e) => e.tipo === "agent.lock.acquired");
    expect(acquired).toHaveLength(1);
    expect(acquired[0]!.payload).toEqual({
      agent_id: "planner",
      accountRef: "NVIDIA_API_KEY",
      provider: "nvidia",
      model: "m1",
    });
    expect(JSON.stringify(audit.readAll())).not.toContain("sk-");
  });

  test("segunda aquisição da mesma conta falha com account_locked e nomeia o dono", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      credentialRef: "NVIDIA_API_KEY",
    });

    let error: unknown;
    try {
      acquireAgentLock(ledger, audit, {
        run: "r2",
        agent_id: "coder",
        session_id: "r2",
        provider: "nvidia",
        credentialRef: "NVIDIA_API_KEY",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AccountLockedError);
    expect((error as AccountLockedError).code).toBe("account_locked");
    expect((error as Error).message).toContain("planner");
    expect((error as Error).message).toContain("r1");
    expect(ledger.readAllEntries().filter((e) => e.kind === "agent")).toHaveLength(1);
  });

  test("o mesmo agente no mesmo run é idempotente e não duplica o created", () => {
    const { ledger, audit } = setup();
    const opts = {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      credentialRef: "NVIDIA_API_KEY",
    } as const;
    const first = acquireAgentLock(ledger, audit, opts);
    const second = acquireAgentLock(ledger, audit, opts);

    expect(second.seq).toBe(first.seq);
    expect(ledger.readAllEntries().filter((e) => e.kind === "agent")).toHaveLength(1);
    expect(audit.readAll().filter((e) => e.tipo === "agent.lock.acquired")).toHaveLength(1);
  });

  test("liberar devolve a conta para outro run e emite agent.lock.released", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      credentialRef: "NVIDIA_API_KEY",
    });

    expect(releaseAgentLock(ledger, audit, { run: "r1", agent_id: "planner", reason: "completed" })).toBe(true);
    expect(activeLocks(ledger)).toEqual([]);

    const released = audit.readAll().filter((e) => e.tipo === "agent.lock.released");
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({
      agent_id: "planner",
      accountRef: "NVIDIA_API_KEY",
      reason: "completed",
    });

    expect(() =>
      acquireAgentLock(ledger, audit, {
        run: "r2",
        agent_id: "coder",
        session_id: "r2",
        provider: "nvidia",
        credentialRef: "NVIDIA_API_KEY",
      }),
    ).not.toThrow();
    expect(releaseAgentLock(ledger, audit, { run: "r1", agent_id: "planner", reason: "again" })).toBe(false);
  });

  test("provider sem credencial usa o provider como conta; providers distintos não colidem", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, { run: "r1", agent_id: "a", session_id: "r1", provider: "local" });

    expect(() =>
      acquireAgentLock(ledger, audit, { run: "r1", agent_id: "b", session_id: "r1", provider: "local" }),
    ).toThrow(AccountLockedError);
    expect(() =>
      acquireAgentLock(ledger, audit, { run: "r1", agent_id: "c", session_id: "r1", provider: "other" }),
    ).not.toThrow();
    expect(accountRefOf({ provider: "local" })).toBe("provider:local");
  });

  test("liberar o lock não libera quota: o consumo segue contado por quotaDomain (I-07)", () => {
    const { ledger, audit } = setup();
    ledger.record({
      run: "r1",
      agent: "planner",
      provider: "nvidia",
      model: "m1",
      credentialRef: "NVIDIA_API_KEY",
      quotaDomain: "nvidia",
      tokensIn: 90,
      tokensOut: 10,
    });
    acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      credentialRef: "NVIDIA_API_KEY",
    });
    releaseAgentLock(ledger, audit, { run: "r1", agent_id: "planner", reason: "completed" });

    expect(ledger.total().tokensIn).toBe(90);
    expect(ledger.total().tokensOut).toBe(10);
    expect(() => assertWithinQuota(ledger, { nvidia: { dailyTokens: 100 } }, "nvidia")).toThrow(/quota excedida/);
  });

  test("recuperação de crash destrói órfãos do run com crash_recovered e libera a conta", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "planner",
      session_id: "r1",
      provider: "nvidia",
      credentialRef: "A_KEY",
    });
    acquireAgentLock(ledger, audit, {
      run: "r1",
      agent_id: "coder",
      session_id: "r1",
      provider: "openrouter",
      credentialRef: "B_KEY",
    });
    acquireAgentLock(ledger, audit, {
      run: "r2",
      agent_id: "planner",
      session_id: "r2",
      provider: "nvidia",
      credentialRef: "C_KEY",
    });

    const recovered = recoverCrashedAgents(ledger, audit, "r1");

    expect(recovered.map((l) => l.agent_id)).toEqual(["planner", "coder"]);
    expect(activeLocks(ledger).map((l) => l.run)).toEqual(["r2"]);
    const destroyed = ledger
      .readAllEntries()
      .filter((e) => e.kind === "agent" && e.event === "destroyed" && e.run === "r1");
    expect(destroyed).toHaveLength(2);
    expect(destroyed.every((e) => (e as { reason?: string }).reason === "crash_recovered")).toBe(true);

    const released = audit.readAll().filter((e) => e.tipo === "agent.lock.released");
    expect(released).toHaveLength(2);
    expect(released.every((e) => e.payload.reason === "crash_recovered")).toBe(true);
    expect(recoverCrashedAgents(ledger, audit, "r1")).toEqual([]);
  });
});
