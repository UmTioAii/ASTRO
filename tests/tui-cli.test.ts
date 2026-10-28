import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TUI_RENDER_OPTIONS } from "../src/tui/run";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("tui desliga o ctrl+c do Ink para a app decidir a saída", () => {
  expect(TUI_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
});

test("tui recusa stdin em pipe sem carregar a interface", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "tui", "--cwd", root], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  const exit = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(exit).toBe(1);
  expect(stderr).toContain("terminal interativo");
});
