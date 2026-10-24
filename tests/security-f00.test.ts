import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ProviderError } from "../src/provider/types";
import { runTask } from "../src/app";
import { readFileTool } from "../src/tools/read-file";
import { runCommandTool } from "../src/tools/run-command";
import { writeFileTool } from "../src/tools/write-file";
import type { ToolContext } from "../src/tools/types";

const dir = () => mkdtempSync(join(tmpdir(), "astro-sec-"));

const ctx = (cwd: string, extra?: Partial<ToolContext>): ToolContext => ({
  cwd,
  run: "sec-f00",
  agent: "tester",
  ...(extra ?? {}),
});

/** Prova se a plataforma suporta link de diretório (junction no Windows). */
function supportsDirectoryLink(): boolean {
  const root = dir();
  const target = dir();
  try {
    symlinkSync(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

const hasDirLink = supportsDirectoryLink();

describe("segurança F-00", () => {
  test("run_command não expõe variáveis de segredo do ambiente de lançamento", async () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, "print-env.js"),
      'console.log(process.env.ASTRO_SEC_SECRET ?? "missing-secret");\n' +
        'console.log(process.env.ASTRO_SEC_SAFE ?? "missing-safe");\n',
    );
    const prevSecret = process.env.ASTRO_SEC_SECRET;
    const prevSafe = process.env.ASTRO_SEC_SAFE;
    process.env.ASTRO_SEC_SECRET = "astro-secret-value";
    process.env.ASTRO_SEC_SAFE = "astro-safe-value";
    try {
      const result = await runCommandTool.execute({ command: "bun print-env.js" }, ctx(cwd));
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("missing-secret");
      expect(result.output).not.toContain("astro-secret-value");
      expect(result.output).toContain("astro-safe-value");
    } finally {
      if (prevSecret === undefined) delete process.env.ASTRO_SEC_SECRET;
      else process.env.ASTRO_SEC_SECRET = prevSecret;
      if (prevSafe === undefined) delete process.env.ASTRO_SEC_SAFE;
      else process.env.ASTRO_SEC_SAFE = prevSafe;
    }
  });

  test("run_command remove credentialRef declarado em secretEnvNames", async () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, "print-cred.js"),
      'console.log(process.env.ASTRO_SEC_CRED ?? "missing-cred");\n',
    );
    const prev = process.env.ASTRO_SEC_CRED;
    // "CRED" não casa com o padrão de nome; só a lista exata remove
    process.env.ASTRO_SEC_CRED = "astro-cred-value";
    try {
      const result = await runCommandTool.execute(
        { command: "bun print-cred.js" },
        ctx(cwd, { secretEnvNames: ["ASTRO_SEC_CRED"] }),
      );
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("missing-cred");
      expect(result.output).not.toContain("astro-cred-value");
    } finally {
      if (prev === undefined) delete process.env.ASTRO_SEC_CRED;
      else process.env.ASTRO_SEC_CRED = prev;
    }
  });

  test("read_file não escapa do cwd por symlink/junction de diretório", async () => {
    if (!hasDirLink) return; // plataforma sem suporte: sem assertions, sem .skip
    const cwd = dir();
    const outside = dir();
    writeFileSync(join(outside, "secreto.txt"), "conteudo-externo");
    symlinkSync(outside, join(cwd, "atalho"), process.platform === "win32" ? "junction" : "dir");
    const result = await readFileTool.execute({ path: "atalho/secreto.txt" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("write_file recusa o estado do harness (.astro/)", async () => {
    const cwd = dir();
    const result = await writeFileTool.execute(
      { path: ".astro/ledger.jsonl", content: "tampado" },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("reservado");
  });

  test("write_file recusa caminho protegido declarado e não sobrescreve", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "protegido.txt"), "original");
    const result = await writeFileTool.execute(
      { path: "protegido.txt", content: "tampado" },
      ctx(cwd, { protectedPaths: [join(cwd, "protegido.txt")] }),
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, "protegido.txt"), "utf8")).toBe("original");
  });

  test("run que falha no provider registra run.stopped com reason e errorClass", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(): Promise<Response> {
        return new Response("unauthorized", { status: 401 });
      },
    });
    const cwd = dir();
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          providers: {
            mock: {
              kind: "openai-compat",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              credentialRef: "ASTRO_SEC_KEY",
            },
          },
          models: [{ provider: "mock", id: "m1", tags: ["fast"], context: 4096 }],
          agent: { model: "mock/m1", maxSteps: 3, tools: [] },
          paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
        }),
      );
      const err = await runTask({
        configPath,
        task: "x",
        cwd,
        env: { ASTRO_SEC_KEY: "chave-de-teste" },
      }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      const auditText = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8");
      expect(auditText).toContain("run.stopped");
      expect(auditText).toContain('"reason":"error"');
      expect(auditText).toContain('"errorClass":"auth"');
      expect(auditText).not.toContain("chave-de-teste");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
