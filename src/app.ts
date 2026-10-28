import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Auditor } from "./audit";
import { isAbortError } from "./abort";
import { SwapDeniedError, swapDelta, type SwapApprover, type SwapRequest } from "./approval";
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
import { resolveTaskSkill } from "./skills/executor";
import type { AuditEvent } from "./audit";
import { MaxStepsError, runSession, runMultiAgentSession, type EffectiveIdentity, type IdentityResolver, type MultiAgentSessionOptions } from "./session";
import { planResume, ReplayIncompleteError } from "./resume";
import { assertWithinQuota, type QuotaLimit } from "./quota";
import { ProviderError } from "./provider/types";
import { MCPRegistry } from "./mcp/registry";
import { mcpTools } from "./mcp/tool";
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
  /** Raiz de skills do usuário (C1c); default `~/.astro/skills`. Injetável para teste. */
  skillsUserRoot?: string;
  /** Sinal de cancelamento do run (F-06); aborta a chamada em voo e para em estado seguro. */
  signal?: AbortSignal;
  /** Gate de aprovação de troca (F-19, I-08); sem ele o runtime nega (pending). Injetável para teste. */
  approveSwap?: SwapApprover;
  /** Run-id a retomar (F-22): reconstrói a árvore do ledger e continua do agente ativo. */
  resume?: string;
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
  /** Agente de onde o run foi retomado (`resume`); ausente em run novo. */
  resumedFrom?: string;
}

const AGENT_NAME = "default";
const TASK_HASH_LENGTH = 16;

const TOOLS: readonly Tool[] = [readFileTool, writeFileTool, runCommandTool, handoffTool, grepTool, listDirTool, editTool, lspTool, pipelineTool];
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.manifest.name, tool]));

/** Env de sistema que o shell precisa; não são segredos, mesmo se o servidor MCP os declarar. */
const SYSTEM_ENV = /^(PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|SHELL|COMSPEC|LANG|LC_ALL|TERM)$/i;

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
  provider: string,
): { credentialRef: string; quotaDomain: string } {
  const providerConfig = config.providers[provider];
  if (providerConfig === undefined) {
    throw new ConfigError(`provider "${provider}" não encontrado na configuração`);
  }
  const quotaDomain = providerConfig.quotaDomain ?? "default";
  if (isOpenAICompat(providerConfig)) return { credentialRef: providerConfig.credentialRef, quotaDomain };
  if (isCodexOAuth(providerConfig)) {
    return { credentialRef: expandHome(providerConfig.credentialsPath), quotaDomain };
  }
  const rawCredentialRef = providerConfig.credentialRef;
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
  const { credentialRef, quotaDomain } = providerIdentity(config, model.provider);

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
    provider: factory.create(providerConfig, env),
    credentialRef,
    quotaDomain,
  };
}

/**
 * Resolve a identidade efetiva (F-31d) para o ledger e a quota. O preço vem do
 * Registry (com override global de pricing); provider desconhecido é erro de
 * config, não identidade silenciosa.
 */
function identityResolver(config: AstroConfig, registry: Registry): IdentityResolver {
  return (provider: string, model: string): EffectiveIdentity | undefined => {
    // Provider de plugin pode devolver um nome próprio fora da config; nesse
    // caso a sessão mantém a identidade base (comportamento anterior).
    if (!Object.hasOwn(config.providers, provider)) return undefined;
    const { credentialRef, quotaDomain } = providerIdentity(config, provider);
    const price = registry.get(`${provider}/${model}`)?.price;
    return {
      provider,
      model,
      credentialRef,
      quotaDomain,
      ...(price === undefined ? {} : { price }),
    };
  };
}

/**
 * Cria o provider com audit verídico e quota no domínio de destino (F-31d).
 * `credential.acquired` só sai quando a credencial é resolvida de fato; a quota
 * é checada por entry, antes da chamada, permitindo pular o profile esgotado.
 */
function createGuardedProvider(
  config: AstroConfig,
  model: ModelEntry,
  env: Record<string, string | undefined>,
  pluginFactories: Map<string, PluginProviderFactory>,
  audit: Auditor,
  run: string,
  ledger: Ledger,
  quotaLimits: Record<string, QuotaLimit> | undefined,
  profile?: string,
  agentName?: () => string,
): Provider {
  const setup = createProvider(config, model, env, pluginFactories);
  audit.append({
    run,
    agent: agentName?.() ?? AGENT_NAME,
    tipo: "credential.acquired",
    payload: {
      provider: model.provider,
      credentialRef: setup.credentialRef,
      quotaDomain: setup.quotaDomain,
      ...(profile === undefined ? {} : { profile }),
    },
  });
  if (quotaLimits === undefined) return setup.provider;
  return {
    complete: async (req, signal) => {
      assertWithinQuota(ledger, quotaLimits, setup.quotaDomain);
      return setup.provider.complete(req, signal);
    },
  };
}

/**
 * Memoiza a criação do provider na primeira chamada (F-31c). Falha de fábrica
 * não fica cacheada: o próximo completion tenta de novo. Preserva o estado em
 * memória do provider (ex.: refresh do Codex OAuth) entre steps.
 */
function memoizedCreate(create: () => Provider): () => Provider {
  let provider: Provider | undefined;
  return () => (provider ??= create());
}

/** Provider criado na primeira chamada (F-31c): credencial só resolve quando o provider entra em uso. */
function lazyProvider(create: () => Provider): Provider {
  const get = memoizedCreate(create);
  return { complete: (req, signal) => get().complete(req, signal) };
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
  ledger: Ledger,
  quotaLimits: Record<string, QuotaLimit> | undefined,
  profile?: string,
  approveSwap?: SwapApprover,
  agentName?: () => string,
): Provider {
  const primaryConfig = config.providers[model.provider];
  return new FallbackProvider({
    providers: [
      {
        name: model.provider,
        priority: primaryConfig?.priority ?? DEFAULT_PRIORITY,
        create: memoizedCreate(() => createGuardedProvider(
          config, model, env, pluginFactories, audit, run, ledger, quotaLimits, profile, agentName,
        )),
      },
      ...(primaryConfig?.fallback ?? []).map((name) => ({
        name,
        priority: config.providers[name]?.priority ?? DEFAULT_PRIORITY,
        create: memoizedCreate(() => createGuardedProvider(
          config, { ...model, provider: name }, env, pluginFactories, audit, run, ledger, quotaLimits, profile, agentName,
        )),
      })),
    ],
    maxRetries: primaryConfig?.maxRetries,
    retryBackoffMs: primaryConfig?.retryBackoffMs,
    audit,
    run,
    ...(profile === undefined ? {} : { profile }),
    ...(approveSwap === undefined ? {} : { approveSwap }),
    ...(agentName === undefined ? {} : { agentName }),
  });
}
/** Valida as tools pedidas pelo agente e devolve as instâncias correspondentes. */
function resolveTools(
  config: AstroConfig,
  toolsByName: Map<string, Tool>,
  warn?: (message: string) => void,
): Tool[] {
  return config.agent.tools.flatMap((name) => {
    const tool = toolsByName.get(name);
    if (tool !== undefined) return [tool];
    // Tool MCP que não conectou fica indisponível, sem derrubar a sessão (C2, #56).
    if (name.startsWith("mcp__") && warn !== undefined) {
      warn(`tool MCP "${name}" indisponível; seguindo sem ela`);
      return [];
    }
    throw new ConfigError(
      `config inválida: tool "${name}" desconhecida em "agent.tools" ` +
        `(disponíveis: ${[...toolsByName.keys()].join(", ")})`,
    );
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

  const run = opts.resume ?? randomUUID();
  /** Gate auditado (F-19): sem approver do caller a decisão é "pending" (não bloqueia TTY). */
  const approveSwap: SwapApprover = async (request) => {
    const from = registry.get(`${request.from.provider}/${request.from.model ?? ""}`);
    const to = registry.get(`${request.to.provider}/${request.to.model ?? ""}`);
    const enriched: SwapRequest = { ...request, ...swapDelta(from, to) };
    const agent = enriched.agent ?? AGENT_NAME;
    const payload = { from: enriched.from, to: enriched.to, reason: enriched.reason, costDeltaUsd: enriched.costDeltaUsd, capabilityDelta: enriched.capabilityDelta };
    audit.append({ run, agent, tipo: "swap.requested", payload });
    if (opts.approveSwap === undefined) {
      audit.append({ run, agent, tipo: "swap.pending", payload });
      throw new SwapDeniedError(enriched, "pending");
    }
    let approved: boolean;
    try {
      approved = await opts.approveSwap(enriched);
    } catch (error) {
      // Approver que lança não deixa decisão sem evento (I-04): nega e para
      if (error instanceof SwapDeniedError) throw error;
      audit.append({ run, agent, tipo: "swap.denied",
        payload: { ...payload, error: error instanceof Error ? error.name : "unknown" } });
      throw new SwapDeniedError(enriched, "denied");
    }
    audit.append({ run, agent, tipo: approved ? "swap.approved" : "swap.denied", payload });
    return approved;
  };
  const registry = new Registry(config);
  const model = registry.require(config.agent.model);
  const hasAgents = config.agents !== undefined && Object.keys(config.agents).length > 0;
  let resumed: ReturnType<typeof planResume> | undefined;
  let resumedModel: ModelEntry | undefined;
  let resumedProfile: string | undefined;
  if (opts.resume !== undefined) {
    resumed = planResume(ledger, run);
    const agentId = resumed.agent.agent_id;
    if (resumed.agent.model === undefined) {
      throw new ReplayIncompleteError(`agente "${agentId}" sem modelo gravado; replay incompleto`);
    }
    if (!hasAgents) {
      if (agentId !== AGENT_NAME) {
        throw new ReplayIncompleteError(`run "${run}" pertence ao agente "${agentId}", mas a config não tem agents; replay incompleto`);
      }
      if (resumed.agent.model !== model.id) {
        throw new ReplayIncompleteError(`modelo do agente "${agentId}" mudou (gravado "${resumed.agent.model}", config "${model.id}"); replay incompleto`);
      }
      resumedModel = model;
    } else {
      const agent = config.agents?.[agentId];
      if (agent === undefined) {
        throw new ReplayIncompleteError(`agente "${agentId}" do run não existe mais na configuração; replay incompleto`);
      }
      const resolved = registry.resolveModel(agent);
      if (resumed.agent.model !== resolved.id) {
        throw new ReplayIncompleteError(`modelo do agente "${agentId}" mudou (gravado "${resumed.agent.model}", config "${resolved.id}"); replay incompleto`);
      }
      resumedModel = resolved;
      resumedProfile = agent.profile;
    }
  }
  const baseModel = resumedModel ?? model;
  const baseProfile = resumedProfile ?? config.agent.profile;
  audit.append({
    run,
    agent: AGENT_NAME,
    tipo: "run.started",
    payload: {
      taskHash: shortTaskHash(opts.task),
      model: `${baseModel.provider}/${baseModel.id}`,
      ...(baseProfile === undefined ? {} : { profile: baseProfile }),
      ...(resumed === undefined ? {} : { resumedFrom: resumed.agent.agent_id }),
    },
  });

  const { credentialRef, quotaDomain } = providerIdentity(config, model.provider);
  assertProviderKind(config, model, loaded.providerFactories);
  const resolveIdentity = identityResolver(config, registry);
  const quotaLimits = config.quota;

  // Fallback entre providers (C6, D-14) + roteamento por profile (F-31).
  // F-31c: providers preguiçosos; sem profile, o caminho é o anterior (C6 só
  // com fallback de provider declarado).
  const baseConfig = config.providers[model.provider];
  /** Agente corrente do multi-agent; os wrappers atribuem swap.* a ele. */
  const activeAgent = { name: AGENT_NAME };
  let effectiveProvider = (baseConfig?.fallback ?? []).length > 0
    ? providerChain(config, model, env, loaded.providerFactories, audit, run, ledger, quotaLimits, undefined, approveSwap, () => activeAgent.name)
    : lazyProvider(() => createGuardedProvider(
      config, model, env, loaded.providerFactories, audit, run, ledger, quotaLimits, undefined, () => activeAgent.name,
    ));

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
          config, profileModel, env, loaded.providerFactories, audit, run, ledger, quotaLimits, name, approveSwap, () => activeAgent.name,
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
      approveSwap,
      agentName: () => activeAgent.name,
    });
  }

  // Completion cache (F6-4): vale para o provider base/profile e para os
  // providers por modelo do multi-agent (mesma instância de cache).
  let cache: CompletionCache | undefined;
  const withCache = (provider: Provider, scope: string): Provider => {
    const c = cache;
    if (c === undefined) return provider;
    return cachedProvider(provider, {
      cache: c,
      scope,
      ttlHours: config.cache!.ttlHours,
      maxEntries: config.cache!.maxEntries,
      onHit: (key) => {
        audit.append({ run, agent: activeAgent.name, tipo: "cache.hit", payload: { key: key.slice(0, 16) } });
      },
    });
  };
  if (config.cache?.enabled === true) {
    cache = new CompletionCache(join(dirname(ledgerPath), "cache.db"));
    effectiveProvider = withCache(effectiveProvider, `${model.provider}/${model.id}`);
  }

  // Provider por modelo do agent (F-31d): o multi-agent troca de modelo e precisa
  // falar com o provider certo, não com o do modelo de entrada. Agents com
  // profile usam o wrapper da pool (roteia por `req.profile`).
  const modelProviders = new Map<string, Provider>();
  const providerFor = (m: ModelEntry, profile?: string): Provider => {
    if (profile !== undefined) return effectiveProvider;
    const key = `${m.provider}/${m.id}`;
    const cached = modelProviders.get(key);
    if (cached !== undefined) return cached;
    const built = (config.providers[m.provider]?.fallback ?? []).length > 0
      ? providerChain(config, m, env, loaded.providerFactories, audit, run, ledger, quotaLimits, undefined, approveSwap, () => activeAgent.name)
      : createGuardedProvider(config, m, env, loaded.providerFactories, audit, run, ledger, quotaLimits, undefined, () => activeAgent.name);
    const wrapped = withCache(built, key);
    modelProviders.set(key, wrapped);
    return wrapped;
  };

  // O shell não deve ver chaves de nenhum provider configurado, mesmo inativo
  const secretEnvNames: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (isOpenAICompat(provider)) {
      secretEnvNames.push(provider.credentialRef);
    }
  }

  // Baseline antes de qualquer conexão MCP: ledger ilegível não pode deixar filho vivo.
  const baseline = ledger.total();

  // MCP (C2, #56): descoberta no início; falha individual não derruba a sessão.
  const mcpServers = config.mcpServers ?? {};
  for (const server of Object.values(mcpServers)) {
    for (const name of Object.keys(server.env ?? {})) {
      // PATH/HOME/etc. do MCP não são segredo e o shell precisa deles (run_command).
      if (!SYSTEM_ENV.test(name)) secretEnvNames.push(name);
    }
  }

  // Tools: builtin + plugins (F7-1); plugin não sobrescreve builtin
  const toolsByName = new Map(TOOLS_BY_NAME);
  for (const tool of loaded.tools) {
    if (!toolsByName.has(tool.manifest.name)) toolsByName.set(tool.manifest.name, tool);
  }
  let mcpRegistry: MCPRegistry | undefined;
  if (Object.keys(mcpServers).length > 0) {
    mcpRegistry = new MCPRegistry({ servers: mcpServers });
    await mcpRegistry.connectAll();
    const warn = (message: string) => console.warn(`mcp: ${message}`);
    for (const tool of mcpTools({ registry: mcpRegistry, servers: mcpServers, audit, reserved: toolsByName.keys(), warn })) {
      toolsByName.set(tool.manifest.name, tool);
    }
  }
  let baseTools: Tool[];
  try {
    baseTools = resolveTools(config, toolsByName, (message) => console.warn(`mcp: ${message}`));
  } catch (error) {
    mcpRegistry?.close();
    throw error;
  }
  const baseExecutor = new ToolExecutor({
    tools: baseTools,
    allow: config.agent.tools,
    audit,
  });

  const startedAt = Date.now();
  // Tracing OTLP (F6-2): habilitado por OTEL_EXPORTER_OTLP_ENDPOINT
  const tracer = tracerFromEnv(env);
  // Cancellation (F-06): o caller fornece o sinal; sem sinal, o run não é cancelável
  const signal = opts.signal;

  let result: { final: string; steps: number; agentsUsed?: string[] };
  try {
    // Skills (C1c): /<nome> vira o prompt da skill; tools da skill ⊆ allowlist (I-01); falha fecha o run
    const task = resolveTaskSkill(opts.task, { cwd, allow: config.agent.tools, audit, run, agent: AGENT_NAME,
      ...(opts.skillsUserRoot === undefined ? {} : { userRoot: opts.skillsUserRoot }) });
    // Se há agents configurados, usa multi-agent session
    if (config.agents && Object.keys(config.agents).length > 0) {
      const entryAgent = resumed?.agent.agent_id ?? config.agent.entryAgent ?? "planner";
      const multiOpts: MultiAgentSessionOptions = {
        run,
        credentialRef,
        quotaDomain,
        cwd,
        provider: effectiveProvider,
        providerFor,
        approveSwap,
        activeAgent,
        registry,
        baseModel: model,
        baseExecutor,
        ledger,
        audit,
        baseMaxSteps: config.agent.maxSteps,
        baseSystemPrompt: config.agent.systemPrompt,
        entryAgent,
        ...(tracer === undefined ? {} : { tracer }),
        resolveIdentity,
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
        signal,
      };
      result = await runMultiAgentSession(multiOpts, task);
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
          resolveIdentity,
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
          signal,
        },
        task,
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

    // Cancelamento explícito (F-06): o estado interrupted já foi gravado pela sessão
    if (isAbortError(error, opts.signal)) {
      audit.append({
        run,
        agent: AGENT_NAME,
        tipo: "run.stopped",
        payload: { reason: "cancelled" },
      });
      throw new Error("run cancelado pelo usuário", { cause: error });
    }

    // Troca não aprovada (F-19): o estado interrupted já foi gravado pela sessão
    if (error instanceof SwapDeniedError) {
      audit.append({ run, agent: error.request.agent ?? activeAgent.name, tipo: "run.stopped",
        payload: { reason: "swap_denied", from: error.request.from, to: error.request.to } });
      throw new Error(`troca não aprovada (${error.decision}); run parado em ponto seguro`, { cause: error });
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
  } finally {
    mcpRegistry?.close(); // sem processo/cliente órfão ao fim do run
  }

  const total = ledger.total();
  const tokensIn = total.tokensIn - baseline.tokensIn;
  const tokensOut = total.tokensOut - baseline.tokensOut;
  const costUsd = baseModel.price === undefined ? null : total.costUsd - baseline.costUsd;

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
      model: `${baseModel.provider}/${baseModel.id}`,
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
    model: `${baseModel.provider}/${baseModel.id}`,
    steps: result.steps,
    tokensIn,
    tokensOut,
    costUsd,
    ledgerPath,
    auditPath,
    agentsUsed: result.agentsUsed,
    ...(resumed === undefined ? {} : { resumedFrom: resumed.agent.agent_id }),
  };
}
