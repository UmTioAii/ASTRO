import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/app";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolResult } from "../src/tools/types";

const big = (): string => Array.from({ length: 400 }, (_, index) => `linha ${index + 1} ${"y".repeat(80)}`).join("\n");

function fakeTool(output: string): Tool {
  return {
    manifest: {
      name: "fake", description: "fake", parameters: { type: "object" },
      risk: "low", permission: "read", timeoutMs: 1000, retryable: false, idempotent: true, sideEffects: "none",
    },
    async execute(): Promise<ToolResult> {
      return { output };
    },
  };
}

describe("limite de saída no executor e na sessão (CMP-10)", () => {
  test("executor trunca acima do cap, grava artefato e sanitiza antes do contexto", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-output-exec-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [fakeTool(`sk-live-0123456789abcdef\n${big()}`)], allow: ["fake"], audit });

    const result = await executor.run(
      { cwd, run: "r1", agent: "coder", outputLimitTokens: 100 },
      { id: "call-9", name: "fake", arguments: "{}" },
    );

    expect(result.output).toContain("saída truncada");
    expect(result.output).toContain("tool_call=call-9");
    expect(result.output).not.toContain("sk-live-0123456789abcdef");
    const artifact = /arquivo=([^\]]+)\]/.exec(result.output)?.[1];
    expect(artifact).toBeDefined();
    expect(existsSync(join(cwd, artifact!))).toBe(true);
  });

  test("executor não trunca abaixo do cap", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-output-exec2-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({ tools: [fakeTool("ok")], allow: ["fake"], audit });

    const result = await executor.run(
      { cwd, run: "r1", agent: "coder", outputLimitTokens: 100 },
      { id: "c1", name: "fake", arguments: "{}" },
    );
    expect(result.output).toBe("ok");
  });

  test("sessão aplica min(maxTokens, 5% da janela) ao output da tool", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-output-session-"));
    mkdirSync(join(cwd, ".astro"), { recursive: true });
    writeFileSync(join(cwd, "big.txt"), Array.from({ length: 30 }, () => "z".repeat(1000)).join("\n"));
    const bodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as { messages?: Array<{ role?: string; content?: string }> });
        calls++;
        if (calls === 1) {
          return Response.json({
            choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "big.txt" }) } }] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
        }
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        // janela 100.000: 5% = 5.000 < 8.000, então o share vence o default.
        models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 100_000 }],
        agent: { model: "mock/m1", maxSteps: 2, tools: ["read_file"] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));

      const report = await runTask({ configPath, task: "x", cwd, env: { KEY: "k" } });
      expect(report.final).toBe("ok");

      const toolMessage = bodies[1]!.messages?.find((message) => message.role === "tool")?.content ?? "";
      expect(toolMessage).toContain("saída truncada");
      expect(toolMessage).toContain("limite 5000");
      const artifact = /arquivo=([^\]]+)\]/.exec(toolMessage)?.[1];
      expect(artifact).toBeDefined();
      expect(existsSync(join(cwd, artifact!))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
