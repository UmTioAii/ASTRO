import { expect, test } from "bun:test";
import { join } from "node:path";

test("--help mostra os comandos com o binário astro", async () => {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn([process.execPath, entry, "--help"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  expect(out).toContain("astro run");
  expect(out).toContain("astro tui");
  expect(out).not.toContain("bun src/cli.ts");
});
