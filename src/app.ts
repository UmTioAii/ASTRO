import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Auditor } from "./audit";
import type { AstroConfig, ProviderConfig } from "./config";
import { ConfigError, loadConfig } from "./config";
import { Ledger } from "./ledger";
import { CodexOAuthProvider } from "./provider/codex-oauth";
import { OpenAICompatProvider } from "./provider/openai-compat";
import type { Provider } from "./provider/types";
import { Registry, type ModelEntry } from "./registry";
import { MaxStepsError, runSession, runMultiAgentSession, type MultiAgentSessionOptions } from "./session";
import { ToolExecutor } from "./tools/executor";
import { readFileTool } from "./tools/read-file";
import { runCommandTool } from "./tools/run-command";
import { writeFileTool } from "./tools/write-file";
import { handoffTool } from "./tools/handoff";
import { grepTool } from "./tools/grep";
import type { Tool } from "./tools/types";

export interface RunOptions {
  configPath: string;
  task: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface RunReport {
  final: string;
  model: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  ledgerPath: string;
  auditPath: string;
  agentsUsed?: string[];
}

const AGENT_NAME = "default";
const TASK_HASH_LENGTH = 16;

const TOOLS: readonly Tool[] = [readFileTool, writeFileTool, runCommandTool, handoffTool, grepTool];
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.manifest.name, tool]));

/** Hash curto da tarefa: permite correlacionar execuções sem persistir o prompt. */
function shortTaskHash(task: string): string {
  return createHash("sha256").update(task).digest("hex").slice(0, TASK_HASH_LENGTH);
}

/** Resolve caminhos relativos ao diretório de trabalho do run. */
function resolveFrom(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Expande "~" e "~/..." para o diretório home do usuário. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

interface ProviderSetup {
  provider: Provider;
  credentialRef: string;
  quotaDomain: string;
}

function providerConfigFor(config: AstroConfig, model: ModelEntry): ProviderConfig {
  const providerConfig = config.providers[model.provider];
  if (providerConfig === undefined) {
    throw new ConfigError(`provider "${model.provider}" não encontrado na configuração`);
  }
  return providerConfig;
}

/**
 * Instancia o provider do modelo pelo `kind`. Segredos vêm apenas do ambiente
 * (`env[credentialRef]`) ou, no Codex, do arquivo de credenciais em modo leitura.
 */
function createProvider(
  config: AstroConfig,
  model: ModelEntry,
  env: Record<string, string | undefined>,
): ProviderSetup {
  const providerConfig = providerConfigFor(config, model);
  const quotaDomain = providerConfig.quotaDomain ?? "default";

  if (providerConfig.kind === "openai-compat") {
    const credentialRef = providerConfig.credentialRef;
    const apiKey = env[credentialRef];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`defina ${credentialRef} no ambiente`);
    }

    return {
      provider: new OpenAICompatProvider({
        baseUrl: providerConfig.baseUrl,
        apiKey,
        ...(providerConfig.headers === undefined ? {} : { headers: providerConfig.headers }),
      }),
      credentialRef,
      quotaDomain,
    };
  }

  const credentialsPath = expandHome(providerConfig.credentialsPath);
  return {
    provider: new CodexOAuthProvider({
      credentialsPath,
      ...(providerConfig.baseUrl === undefined ? {} : { baseUrl: providerConfig.baseUrl }),
      ...(providerConfig.headers === undefined ? {} : { headers: providerConfig.headers }),
    }),
    credentialRef: credentialsPath,
    quotaDomain,
  };
}

/** Valida as tools pedidas pelo agente e devolve as instâncias correspondentes. */
function resolveTools(config: AstroConfig): Tool[] {
  return config.agent.tools.map((name) => {
    const tool = TOOLS_BY_NAME.get(name);
    if (tool === undefined) {
      throw new ConfigError(
        `config inválida: tool "${name}" desconhecida em "agent.tools" ` +
          `(disponíveis: ${[...TOOLS_BY_NAME.keys()].join(", ")})`,
      );
    }
    return tool;
  });
}

/**
 * Executa uma tarefa ponta a ponta: carrega a config, cria auditoria/ledger,
 * instancia provider e tools, roda a sessão e devolve um relatório do run.
 */
export async function runTask(opts: RunOptions): Promise<RunReport> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const config = loadConfig(opts.configPath);

  const ledgerPath = resolveFrom(cwd, config.paths.ledger);
  const auditPath = resolveFrom(cwd, config.paths.audit);
  const ledger = new Ledger(ledgerPath);
  const audit = new Auditor(auditPath);

  const run = randomUUID();
  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "run.started",
    payload: { taskHash: shortTaskHash(opts.task), model: config.agent.model },
  });

  const registry = new Registry(config);
  const model = registry.require(config.agent.model);

  const { provider, credentialRef, quotaDomain } = createProvider(config, model, env);
  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "credential.acquired",
    payload: { provider: model.provider, credentialRef, quotaDomain },
  });

  const baseTools = resolveTools(config);
  const baseExecutor = new ToolExecutor({
    tools: baseTools,
    allow: config.agent.tools,
    audit,
  });

  const baseline = ledger.total();

  let result: { final: string; steps: number; agentsUsed?: string[] };
  try {
    // Se há agents configurados, usa multi-agent session
    if (config.agents && Object.keys(config.agents).length > 0) {
      const entryAgent = config.agent.entryAgent ?? "planner";
      const multiOpts: MultiAgentSessionOptions = {
        run,
        credentialRef,
        quotaDomain,
        cwd,
        provider,
        registry,
        baseModel: model,
        baseExecutor,
        ledger,
        audit,
        baseMaxSteps: config.agent.maxSteps,
        baseSystemPrompt: config.agent.systemPrompt,
        entryAgent,
      };
      result = await runMultiAgentSession(multiOpts, opts.task);
    } else {
      result = await runSession(
        {
          run,
          agent: AGENT_NAME,
          credentialRef,
          quotaDomain,
          cwd,
          provider,
          model,
          executor: baseExecutor,
          ledger,
          audit,
          maxSteps: config.agent.maxSteps,
          ...(config.agent.systemPrompt === undefined
            ? {}
            : { systemPrompt: config.agent.systemPrompt }),
        },
        opts.task,
      );
    }
  } catch (error) {
    if (!(error instanceof MaxStepsError)) throw error;

    audit.append({
      run,
      agent: AGENT_NAME,
      tipo: "run.stopped",
      payload: { reason: "max_steps" },
    });
    throw new Error(
      `a tarefa excedeu ${config.agent.maxSteps} passos sem resposta final; ` +
        `aumente "agent.maxSteps" na configuração`,
      { cause: error },
    );
  }

  const total = ledger.total();
  const tokensIn = total.tokensIn - baseline.tokensIn;
  const tokensOut = total.tokensOut - baseline.tokensOut;
  const costUsd = model.price === undefined ? null : total.costUsd - baseline.costUsd;

  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "run.completed",
    payload: { steps: result.steps, tokensIn, tokensOut, costUsd, agentsUsed: result.agentsUsed },
  });

  return {
    final: result.final,
    model: config.agent.model,
    steps: result.steps,
    tokensIn,
    tokensOut,
    costUsd,
    ledgerPath,
    auditPath,
    agentsUsed: result.agentsUsed,
  };
}
