import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistLastModel } from "../src/tui/app";

test("falha ao persistir o último modelo vira aviso, não erro", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-last-model-"));
  const file = join(dir, "arquivo"); // cwd é um arquivo: .astro/tui.json não pode ser criado
  writeFileSync(file, "x");
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(() => persistLastModel(file, "p/m1")).not.toThrow();
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
