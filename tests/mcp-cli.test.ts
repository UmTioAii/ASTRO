import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMcpCommand } from "../src/mcp/cli";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Servidor MCP stdio mínimo: initialize/tools/list/tools/call com eco. */
const STUB = `
import { appendFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line);
    const reply = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
    if (msg.method === "initialize") {
      if (process.env.PID_FILE !== undefined) appendFileSync(process.env.PID_FILE, process.pid + "\\n");
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "cli-stub", version: "1" } } });
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Ecoa o texto" }] } });
    } else if (msg.method === "tools/call") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "eco:" + (msg.params.arguments?.text ?? "") }] } });
    }
  }
});
`;

/** Projeto temporário com config válida; `mcpServers` varia por teste. */
function setup(mcpServers: (dir: string) => Record<string, unknown>, configName = "astro.config.json") {
  const dir = mkdtempSync(join(tmpdir(), "astro-mcpcli-"));
  writeFileSync(join(dir, "server.js"), STUB.trim());
  const config = {
    providers: { mock: { kind: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", credentialRef: "TEST_KEY" } },
    models: [{ provider: "mock", id: "m", tags: ["writing-code"], context: 4096 }],
    agent: { model: "mock/m", maxSteps: 1, tools: [] },
    mcpServers: mcpServers(dir),
    paths: { ledger: "ledger.jsonl", audit: "audit.jsonl" },
  };
  writeFileSync(join(dir, configName), JSON.stringify(config));
  const captured: string[] = [];
  return { dir, configPath: join(dir, configName), out: (line: string) => { captured.push(line); }, lines: () => captured.join("\n") };
}

const stdio = (dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  transport: "stdio", command: "bun", args: [join(dir, "server.js")], timeoutMs: 3000, enabled: true,
  env: { PID_FILE: join(dir, "pids") }, ...overrides,
});

async function waitDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { return true; }
  }
  return false;
}

function pidOf(dir: string): number | undefined {
  const file = join(dir, "pids");
  return existsSync(file) ? Number(readFileSync(file, "utf8").split("\n").filter(Boolean)[0]) : undefined;
}

test("mcp list mostra servidor, estado e tools descobertas; close mata o processo", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["list"], { cwd: dir, out })).toBe(0);

  const text = lines();
  expect(text).toContain("Servidor: mock");
  expect(text).toContain("stdio");
  expect(text).toContain("habilitado");
  expect(text).toContain("mcp__mock__echo");
  expect(text).toContain("Ecoa o texto");
  expect(await waitDead(pidOf(dir)!)).toBe(true);
  expect(existsSync(join(dir, "audit.jsonl"))).toBe(false); // list não executa tool: nada a auditar
});

test("mcp list sem servidores (com --config) avisa e sai 0", async () => {
  const { dir, out, lines } = setup(() => ({}), "vazia.json");

  expect(await runMcpCommand(["list", "--config", "vazia.json"], { cwd: dir, out })).toBe(0);
  expect(lines()).toContain("nenhum servidor MCP configurado");
});

test("mcp list mostra desabilitado sem conectar", async () => {
  const { dir, out, lines } = setup((d) => ({ off: stdio(d, { enabled: false }) }));

  expect(await runMcpCommand(["list"], { cwd: dir, out })).toBe(0);
  const text = lines();
  expect(text).toContain("Servidor: off");
  expect(text).toContain("desabilitado");
  expect(existsSync(join(dir, "pids"))).toBe(false); // nunca spawnou
});

test("mcp list não derruba o comando quando o servidor cai", async () => {
  const { dir, out, lines } = setup(() => ({ bad: { transport: "stdio", command: "astro-mcp-clone-inexistente", args: [], timeoutMs: 2000, enabled: true } }));

  expect(await runMcpCommand(["list"], { cwd: dir, out })).toBe(0);
  expect(lines()).toContain("indisponível");
});

test("mcp test executa a tool, imprime o texto e audita mcp.call sem argumentos", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["test", "mock", "echo", "--args", "{\"text\":\"oi\"}"], { cwd: dir, out })).toBe(0);
  expect(lines()).toContain("eco:oi");
  expect(await waitDead(pidOf(dir)!)).toBe(true);

  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
  expect(audit).toContain("\"tipo\":\"mcp.call\"");
  expect(audit).toContain("\"server\":\"mock\"");
  expect(audit).not.toContain("eco:"); // argumento/resposta nunca no audit (I-03)
});

test("mcp test com tool inexistente sai 1 e ainda fecha o servidor", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["test", "mock", "ghost"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain("tool \"mcp__mock__ghost\" não encontrada");
  expect(await waitDead(pidOf(dir)!)).toBe(true);
});

test("mcp test rejeita --args que não é objeto JSON, sem conectar", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["test", "mock", "echo", "--args", "{"], { cwd: dir, out })).toBe(1);
  expect(await runMcpCommand(["test", "mock", "echo", "--args", "[1]"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain("--args deve ser um objeto JSON válido");
  expect(existsSync(join(dir, "pids"))).toBe(false); // validação antes de conectar
});

test("mcp sem subcomando válido sai 1 com uso", async () => {
  const { dir, out, lines } = setup(() => ({}));

  expect(await runMcpCommand([], { cwd: dir, out })).toBe(1);
  expect(await runMcpCommand(["bla"], { cwd: dir, out })).toBe(1);
  expect(await runMcpCommand(["test", "mock"], { cwd: dir, out })).toBe(1);
  const text = lines();
  expect(text).toContain("uso: mcp");
  expect(text).toContain("subcomando desconhecido: \"bla\"");
});

test("mcp valida ramos órfãos antes de conectar: duplicado, argumentos demais e flag repetida", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["list", "list"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain('subcomando duplicado: "list"');
  expect(await runMcpCommand(["list", "extra"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain('argumentos demais para list: "extra"');
  expect(await runMcpCommand(["test", "mock", "echo", "extra"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain('argumentos demais para test: "extra"');
  expect(await runMcpCommand(["list", "--config"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain("falta o valor de --config");
  expect(await runMcpCommand(["list", "--config", "a.json", "--config", "b.json"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain("erro: --config duplicado");
  expect(existsSync(join(dir, "pids"))).toBe(false); // tudo rejeitado antes de spawnar
});

test("mcp list rejeita --args, que só é válido em test", async () => {
  const { dir, out, lines } = setup((d) => ({ mock: stdio(d) }));

  expect(await runMcpCommand(["list", "--args", "{}"], { cwd: dir, out })).toBe(1);
  expect(lines()).toContain("erro: --args só é válido com test");
  expect(existsSync(join(dir, "pids"))).toBe(false);
});

test("bun src/cli.ts mcp list executa o wiring real do comando", async () => {
  const { dir, configPath } = setup((d) => ({ mock: stdio(d) }));

  const proc = Bun.spawn(["bun", "src/cli.ts", "mcp", "list", "--config", configPath], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  expect(exit).toBe(0);
  expect(stdout).toContain("Servidor: mock");
  expect(stdout).toContain("mcp__mock__echo");
  expect(await waitDead(pidOf(dir)!)).toBe(true);
});
