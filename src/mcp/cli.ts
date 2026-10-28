import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Auditor } from "../audit";
import { loadConfig } from "../config";
import { MCPRegistry } from "./registry";
import { mcpTools } from "./tool";

const USAGE_MCP = `uso: mcp <subcomando> [--config <caminho>]
  list                  lista servidores MCP e tools descobertas
  test <server> <tool>  executa a tool; --args '<json>' (default: {})`;

/** Saída injetável para teste; defaults seguem o convênio do ASTRO. */
export interface McpCliOptions {
  cwd?: string;
  out?: (line: string) => void;
}

/** CLI de diagnóstico MCP (C2f, #56): list | test. Retorna exit code, nunca process.exit. */
export async function runMcpCommand(argv: string[], opts: McpCliOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((line: string) => console.log(line));

  let sub: "list" | "test" | undefined;
  let server: string | undefined;
  let tool: string | undefined;
  let args: unknown = {};
  let argsProvided = false;
  let configProvided = false;
  let configPath = "astro.config.json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--config" || arg === "--args") {
      if (arg === "--config" && configProvided) {
        out("erro: --config duplicado");
        return 1;
      }
      if (arg === "--args" && argsProvided) {
        out("erro: --args duplicado");
        return 1;
      }
      const value = argv.at(i + 1);
      if (value === undefined || value.startsWith("-")) {
        out(`erro: falta o valor de ${arg}`);
        return 1;
      }
      i++;
      if (arg === "--config") {
        configPath = value;
        configProvided = true;
      } else {
        try {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("não-objeto");
          args = parsed;
          argsProvided = true;
        } catch {
          out("erro: --args deve ser um objeto JSON válido");
          return 1;
        }
      }
      continue;
    }
    if (arg === "list" || arg === "test") {
      if (sub !== undefined) {
        out(`erro: subcomando duplicado: "${arg}"`);
        return 1;
      }
      sub = arg;
      continue;
    }
    if (sub === "test") {
      if (server === undefined) server = arg;
      else if (tool === undefined) tool = arg;
      else {
        out(`erro: argumentos demais para test: "${arg}"`);
        return 1;
      }
      continue;
    }
    if (sub === "list") {
      out(`erro: argumentos demais para list: "${arg}"`);
      return 1;
    }
    out(`subcomando desconhecido: "${arg}"`);
    out(USAGE_MCP);
    return 1;
  }

  if (sub === undefined) {
    out(USAGE_MCP);
    return 1;
  }
  if (sub === "list" && argsProvided) {
    out("erro: --args só é válido com test");
    return 1;
  }
  if (sub === "test" && (server === undefined || tool === undefined)) {
    out("erro: test exige <server> e <tool>");
    out(USAGE_MCP);
    return 1;
  }

  try {
    const config = loadConfig(resolve(cwd, configPath));
    const servers = config.mcpServers ?? {};
    if (sub === "list" && Object.keys(servers).length === 0) {
      out("nenhum servidor MCP configurado");
      return 0;
    }

    const registry = new MCPRegistry({ servers, warn: (message) => out(`aviso: ${message}`) });
    try {
      if (sub === "list") {
        const { failed } = await registry.connectAll();
        const failedOf = new Map(failed.map((entry) => [entry.server, entry.error]));
        const tools = mcpTools({
          registry,
          servers,
          // list não executa tool: nada a auditar, sem efeito de criar arquivo.
          audit: { append: () => {} },
          reserved: [],
          warn: (message) => out(`aviso: ${message}`),
        });
        for (const name of Object.keys(servers)) {
          const serverConfig = servers[name]!;
          const state = serverConfig.enabled === false
            ? "desabilitado"
            : failedOf.has(name) ? `indisponível: ${failedOf.get(name)}` : "habilitado";
          out(`Servidor: ${name} — ${serverConfig.transport}, ${state}`);
          if (serverConfig.enabled === false) continue;
          const mine = tools.filter((entry) => entry.manifest.name.startsWith(`mcp__${name}__`));
          if (mine.length === 0) out("  (nenhuma tool descoberta)");
          for (const entry of mine) out(`  ${entry.manifest.name}  ${entry.manifest.description}`);
        }
        return 0;
      }

      // test: descobre, executa e audita via adaptador (mcp.call sem argumentos/resposta, I-03).
      await registry.connectAll();
      const audit = new Auditor(resolve(cwd, config.paths.audit));
      const tools = mcpTools({
        registry,
        servers,
        audit,
        reserved: [],
        warn: (message) => out(`aviso: ${message}`),
      });
      const wanted = `mcp__${server}__${tool}`;
      const found = tools.find((entry) => entry.manifest.name === wanted);
      if (found === undefined) {
        out(`erro: tool "${wanted}" não encontrada`);
        return 1;
      }
      const result = await found.execute(args, { cwd, run: `mcp-cli-${randomUUID()}`, agent: "cli" });
      if (result.isError) {
        out(`erro: ${result.output}`);
        return 1;
      }
      out(result.output);
      return 0;
    } finally {
      registry.close();
    }
  } catch (error) {
    out(`erro: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
