import { describe, expect, test } from "bun:test";
import { debounce } from "./debounce";

describe("debounce", () => {
  test("executa após o delay", async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 10);
    fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(1);
  });
});
