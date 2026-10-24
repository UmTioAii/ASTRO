import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { callId, CallJournal } from "../src/call-id";

const call = { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) };

describe("callId (F-03)", () => {
  test("determinístico: mesma entrada, mesma saída", () => {
    expect(callId("r1", 1, call)).toBe(callId("r1", 1, call));
  });

  test("formato: SHA-256 hex de run|step|name|arguments", () => {
    const expected = createHash("sha256")
      .update(`r1|1|read_file|${call.arguments}`)
      .digest("hex");
    expect(callId("r1", 1, call)).toBe(expected);
    expect(callId("r1", 1, call)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("muda com run, step, name e arguments", () => {
    const base = callId("r1", 1, call);
    expect(callId("r2", 1, call)).not.toBe(base);
    expect(callId("r1", 2, call)).not.toBe(base);
    expect(callId("r1", 1, { ...call, name: "write_file" })).not.toBe(base);
    expect(callId("r1", 1, { ...call, arguments: "{}" })).not.toBe(base);
  });

  test("id do provider não entra no call_id", () => {
    const other: typeof call = { ...call, id: "outra-id" };
    expect(callId("r1", 1, other)).toBe(callId("r1", 1, call));
  });
});

describe("CallJournal (F-03)", () => {
  test("record e lookup por call_id; miss devolve undefined", () => {
    const j = new CallJournal();
    j.record("x", { output: "ok" });
    expect(j.lookup("x")).toEqual({ output: "ok" });
    expect(j.lookup("y")).toBeUndefined();
  });

  test("registra também resultado de erro", () => {
    const j = new CallJournal();
    j.record("e", { output: "falha", isError: true });
    expect(j.lookup("e")!.isError).toBe(true);
  });

  test("primeiro resultado vence: record não sobrescreve", () => {
    const j = new CallJournal();
    j.record("x", { output: "primeiro" });
    j.record("x", { output: "segundo" });
    expect(j.lookup("x")!.output).toBe("primeiro");
  });
});
