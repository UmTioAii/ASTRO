import { expect, test } from "bun:test";
import { delimiter } from "node:path";
import { smokeEnv } from "../scripts/smoke-env";

test("remove todas as grafias de PATH e mantém o resto", () => {
  const env = smokeEnv({
    Path: "C:\\bun",
    PATH: "C:\\npm",
    path: "C:\\outro",
    FOO: "1",
    VAZIO: undefined,
  }, ["C:\\node", "C:\\Windows\\System32"]);

  expect(env.PATH).toBe(["C:\\node", "C:\\Windows\\System32"].join(delimiter));
  expect(env.Path).toBeUndefined();
  expect(env.path).toBeUndefined();
  expect(env.FOO).toBe("1");
  expect(env.VAZIO).toBeUndefined();
});
