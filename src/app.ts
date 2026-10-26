import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Auditor } from "./audit";
import type { AstroConfig, CodexOAuthProviderConfig, OpenAICompatProviderConfig, ProviderConfig } from "./config";
import { ConfigError, loadConfig } from "./config";
import { Ledger } from "./ledger";
import { CodexOAuthProvider } from "./provider/codex-oauth";
import { OpenAICompatProvider } from "./provider/openai-compat";
import { FallbackProvider, DEFAULT_PRIORITY } from "./provider/fallback-provider";
import { ProfileFallbackProvider, type ProfileChainEntry } from "./provider/profile-fallback-provider";
import type { Provider } from "./provider/types";
import { Registry, type ModelEntry } from "./registry";
import { sendTelemetry } from "./telemetry";
import { tracerFromEnv } from "./tracing";
import { Metrics, MetricsCollector } from "./metrics";
import { CompletionCache, cachedProvider } from "./cache";
import { loadPlugins, type PluginProviderFactory } from "./plugins";
import { sendAuditWebhook } from "./team";
import type { AuditEvent } from "./audit";
import { MaxStepsError, runSession, runMultiAgentSession, type MultiAgentSessionOptions } from "./session";
import { ProviderError } from "./provider/types";
import { ToolExecutor } from "./tools/executor";
import { readFileTool } from "./tools/read-file";
import { runCommandTool } from "./tools/run-command";
import { writeFileTool } from "./tools/write-file";
import { handoffTool } from "./tools/handoff";
import { grepTool } from "./tools/grep";
import { listDirTool } from "./tools/list-dir";
import { editTool } from "./tools/edit";
import { lspTool } from "./tools/lsp";
import { pipelineTool } from "./tools/pipeline";
import { configureRunCommand } from "./tools/run-command";
import type { Tool } from "./tools/types";

export interface RunOptions {
  configPath: string;
  task: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Registro de métricas Prometheus (F6-1); quando presente, alimentado pelo run. */
  metrics?: Metrics;
}

export interface RunReport {
  /** UUID do run (para replay/correlação com a auditoria). */
  runId: string;
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

const TOOLS: readonly Tool[] = [readFileTool, writeFileTool, runCommandTool, handoffTool, grepTool, listDirTool, editTool, lspTool, pipelineTool];
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
 * Identidade do provider (F-31c) sem resolver credencial: permite montar a
 * cadeia de fallback antes de instanciar o primário.
 */
function providerIdentity(
  config: AstroConfig,
  model: ModelEntry,
): { credentialRef: string; quotaDomain: string } {
  const providerConfig = providerConfigFor(config, model);
  const quotaDomain = providerConfig.quotaDomain ?? "default";
  if (isOpenAICompat(providerConfig)) return { credentialRef: providerConfig.credentialRef, quotaDomain };
  if (isCodexOAuth(providerConfig)) {
    return { credentialRef: expandHome(providerConfig.credentialsPath), quotaDomain };
  }
  const rawCredentialRef = (providerConfig as Record<string, unknown>).credentialRef;
  return {
    credentialRef: typeof rawCredentialRef === "string" ? rawCredentialRef : providerConfig.kind,
    quotaDomain,
  };
}

// Predicates de narrowing: PluginProviderConfig tem kind: string, que
// sobrepõe os literais dos built-ins e desativa a discriminação automática.
function isOpenAICompat(p: ProviderConfig): p is OpenAICompatProviderConfig {
  return p.kind === "openai-compat";
}

function isCodexOAuth(p: ProviderConfig): p is CodexOAuthProviderConfig {
  return p.kind === "codex-oauth";
}

/**
 * Instancia o provider do modelo pelo `kind`. Segredos vêm apenas do ambiente
 * (`env[credentialRef]`) ou, no Codex, do arquivo de credenciais em modo leitura.
 * Kinds de plugin (F7-1) são criados pela factory registrada pelo plugin.
 * Exportado para o bench CLI construir providers a partir da config.
 */
export function createProvider(
  config: AstroConfig,
  model: ModelEntry,
  env: Record<string, string | undefined>,
  pluginFactories: Map<string, PluginProviderFactory> = new Map(),
): ProviderSetup {
  const providerConfig = providerConfigFor(config, model);
  const { credentialRef, quotaDomain } = providerIdentity(config, model);

  if (isOpenAICompat(providerConfig)) {
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

  if (isCodexOAuth(providerConfig)) {
    return {
      provider: new CodexOAuthProvider({
        credentialsPath: credentialRef,
        ...(providerConfig.baseUrl === undefined ? {} : { baseUrl: providerConfig.baseUrl }),
        ...(providerConfig.headers === undefined ? {} : { headers: providerConfig.headers }),
      }),
      credentialRef,
      quotaDomain,
    };
  }

  // Provider de plugin (F7-1): factory keyed por kind
  const factory = pluginFactories.get(providerConfig.kind);
  if (factory === undefined) {
    throw new ConfigError(
      `provider "${model.provider}" usa kind "${providerConfig.kind}" sem factory; ` +
        `registre um plugin que exporte esse kind`,
    );
  }
  return {
    provider: factory.create(providerConfig as Record<string, unknown>, env),
    credentialRef,
    quotaDomain,
  };
}

/** Provider criado na primeira chamada (F-31c): credencial só resolve quando o provider entra em uso. */
function lazyProvider(create: () => Provider): Provider {
  let provider: Provider | undefined;
  return { complete: (req) => (provider ??= create()).complete(req) };
}

/**
 * Confere o kind do provider base sem instanciar (F-31c): factory de plugin
 * ausente deve falhar no startup, como antes da criação preguiçosa.
 */
function assertProviderKind(
  config: AstroConfig,
  model: ModelEntry,
  pluginFactories: Map<string, PluginProviderFactory>,
): void {
  const providerConfig = providerConfigFor(config, model);
  if (isOpenAICompat(providerConfig) || isCodexOAuth(providerConfig)) return;
  if (pluginFactories.has(providerConfig.kind)) return;
  throw new ConfigError(
    `provider "${model.provider}" usa kind "${providerConfig.kind}" sem factory; ` +
      `registre um plugin que exporte esse kind`,
  );
}

/**
 * Cadeia C6 de um modelo (F-31c), com providers criados sob demanda. Com
 * `profile`, a cadeia é sempre montada (mesmo sem fallback de provider) para
 * aplicar o retry da F-01 e atribuir `provider.*` ao profile.
 */
function providerChain(
  config: AstroConfig,
  model: ModelEntry,
  env: Record<string, string | undefined>,
  pluginFactories: Map<string, PluginProviderFactory>,
  audit: Auditor,
  run: string,
  profile?: string,
): Provider {
  const primaryConfig = config.providers[model.provider];
  return new FallbackProvider({
    providers: [
      {
        name: model.provider,
        priority: primaryConfig?.priority ?? DEFAULT_PRIORITY,
        create: () => createProvider(config, model, env, pluginFactories).provider,
      },
      ...(primaryConfig?.fallback ?? []).map((name) => ({
        name,
        priority: config.providers[name]?.priority ?? DEFAULT_PRIORITY,
        create: () => createProvider(config, { ...model, provider: name }, env, pluginFactories).provider,
      })),
    ],
    maxRetries: primaryConfig?.maxRetries,
    retryBackoffMs: primaryConfig?.retryBackoffMs,
    audit,
    run,
    ...(profile === undefined ? {} : { profile }),
  });
}
/** Valida as tools pedidas pelo agente e devolve as instâncias correspondentes. */
function resolveTools(config: AstroConfig, toolsByName: Map<string, Tool>): Tool[] {
  return config.agent.tools.map((name) => {
    const tool = toolsByName.get(name);
    if (tool === undefined) {
      throw new ConfigError(
        `config inválida: tool "${name}" desconhecida em "agent.tools" ` +
          `(disponíveis: ${[...toolsByName.keys()].join(", ")})`,
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

  // Plugins (F7-1): tools e provider factories; falha de load é isolada
  const loaded = await loadPlugins(config.plugins ?? []);

  // Sandbox do run_command (F4-6): configurado antes de qualquer execução
  configureRunCommand({ sandbox: config.tools?.run_command?.sandbox ?? false });

  const ledgerPath = resolveFrom(cwd, config.paths.ledger);
  const auditPath = resolveFrom(cwd, config.paths.audit);
  // Métricas Prometheus (F6-1) + webhook de auditoria (F7-5): callbacks compostos
  const collector = opts.metrics !== undefined ? new MetricsCollector(opts.metrics) : undefined;
  const webhookUrl = config.team?.auditWebhook;
  const ledger = new Ledger(ledgerPath, ...(collector ? [{ onRecord: collector.onLedgerRecord }] : []));
  const onEvent =
    collector === undefined && webhookUrl === undefined
      ? undefined
      : (event: AuditEvent): void => {
          collector?.onAuditEvent(event);
          if (webhookUrl !== undefined) void sendAuditWebhook(webhookUrl, event);
        };
  const audit = new Auditor(auditPath, ...(onEvent === undefined ? [] : [{ onEvent }]));

  const run = randomUUID();
  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "run.started",
    payload: { taskHash: shortTaskHash(opts.task), model: config.agent.model },
  });

  const registry = new Registry(config);
  const model = registry.require(config.agent.model);
  const { credentialRef, quotaDomain } = providerIdentity(config, model);
  assertProviderKind(config, model, loaded.providerFactories);

  // Fallback entre providers (C6, D-14) + roteamento por profile (F-31).
  // F-31c: providers preguiçosos; sem profile, o caminho é o anterior (C6 só
  // com fallback de provider declarado).
  const baseConfig = config.providers[model.provider];
  let effectiveProvider = (baseConfig?.fallback ?? []).length > 0
    ? providerChain(config, model, env, loaded.providerFactories, audit, run)
    : lazyProvider(() => createProvider(config, model, env, loaded.providerFactories).provider);

  const pool = config.modelPool ?? {};
  if (Object.keys(pool).length > 0) {
    const profiles: ProfileChainEntry[] = Object.entries(pool).map(([name, profile]) => {
      const profileModel = registry.resolveProfile(name);
      let chain: Provider | undefined;
      return {
        name,
        model: profileModel.id,
        provider: profileModel.provider,
        fallback: profile.fallback ?? [],
        create: () => (chain ??= providerChain(
          config, profileModel, env, loaded.providerFactories, audit, run, name,
        )),
      };
    });
    // Sem defaultProfile: só `req.profile` roteia; agent nomeado sem profile
    // mantém o model dele (F-31c).
    effectiveProvider = new ProfileFallbackProvider({
      base: effectiveProvider,
      profiles,
      audit,
      run,
    });
  }

  // Completion cache (F6-4): wrap do provider com cache SQLite (por cima do fallback quando ativo)
  if (config.cache?.enabled === true) {
    const cacheDbPath = join(dirname(ledgerPath), "cache.db");
    const cache = new CompletionCache(cacheDbPath);
    effectiveProvider = cachedProvider(effectiveProvider, {
      cache,
      ttlHours: config.cache.ttlHours,
      maxEntries: config.cache.maxEntries,
      onHit: (key) => {
        audit.append({
          run,
          agent: AGENT_NAME,
          tipo: "cache.hit",
          payload: { key: key.slice(0, 16) },
        });
      },
    });
  }
  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "credential.acquired",
    payload: { provider: model.provider, credentialRef, quotaDomain },
  });

  // O shell não deve ver chaves de nenhum provider configurado, mesmo inativo
  const secretEnvNames: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (isOpenAICompat(provider)) {
      secretEnvNames.push(provider.credentialRef);
    }
  }

  // Tools: builtin + plugins (F7-1); plugin não sobrescreve builtin
  const toolsByName = new Map(TOOLS_BY_NAME);
  for (const tool of loaded.tools) {
    if (!toolsByName.has(tool.manifest.name)) toolsByName.set(tool.manifest.name, tool);
  }
  const baseTools = resolveTools(config, toolsByName);
  const baseExecutor = new ToolExecutor({
    tools: baseTools,
    allow: config.agent.tools,
    audit,
  });

  const baseline = ledger.total();
  const startedAt = Date.now();
  // Tracing OTLP (F6-2): habilitado por OTEL_EXPORTER_OTLP_ENDPOINT
  const tracer = tracerFromEnv(env);

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
        provider: effectiveProvider,
        registry,
        baseModel: model,
        baseExecutor,
        ledger,
        audit,
        baseMaxSteps: config.agent.maxSteps,
        baseSystemPrompt: config.agent.systemPrompt,
        entryAgent,
        ...(tracer === undefined ? {} : { tracer }),
        ...(config.quota === undefined ? {} : { quotaLimits: config.quota }),
        ...(config.team === undefined
          ? {}
          : {
              teamLimits: {
                ...(config.team.projectBudgetUsd === undefined
                  ? {}
                  : { projectBudgetUsd: config.team.projectBudgetUsd }),
                ...(config.team.agentQuotas === undefined
                  ? {}
                  : { agentQuotas: config.team.agentQuotas }),
              },
            }),
        env,
        protectedPaths: [ledgerPath, auditPath],
        secretEnvNames,
        // Handoff (F-24): timeout do ack; default 30000ms (D-15)
        ...(config.handoff === undefined ? {} : { ackTimeoutMs: config.handoff.ackTimeoutMs }),
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
          provider: effectiveProvider,
          model,
          executor: baseExecutor,
          ledger,
          audit,
          maxSteps: config.agent.maxSteps,
          ...(config.agent.profile === undefined ? {} : { agentProfile: config.agent.profile }),
          ...(config.agent.systemPrompt === undefined
            ? {}
            : { systemPrompt: config.agent.systemPrompt }),
          ...(tracer === undefined ? {} : { tracer }),
          ...(config.quota === undefined ? {} : { quotaLimits: config.quota }),
          ...(config.team === undefined
            ? {}
            : {
                teamLimits: {
                  ...(config.team.projectBudgetUsd === undefined
                    ? {}
                    : { projectBudgetUsd: config.team.projectBudgetUsd }),
                  ...(config.team.agentQuotas === undefined
                    ? {}
                    : { agentQuotas: config.team.agentQuotas }),
                },
              }),
          env,
          protectedPaths: [ledgerPath, auditPath],
          secretEnvNames,
        },
        opts.task,
      );
    }
  } catch (error) {
    if (error instanceof MaxStepsError) {
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

    // Falha terminal: auditar reason e classe do erro (I-04), sem segredo (I-03)
    audit.append({
      run,
      agent: AGENT_NAME,
      tipo: "run.stopped",
      payload: {
        reason: "error",
        error: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof ProviderError ? { errorClass: error.errClass } : {}),
      },
    });
    throw error;
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

  // Telemetria opt-in (F5-5): métricas anônimas; falha nunca derruba o run
  if (config.telemetry !== undefined) {
    await sendTelemetry(config.telemetry, {
      runId: run,
      model: config.agent.model,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      steps: result.steps,
      costUsd,
    });
  }

  return {
    runId: run,
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
