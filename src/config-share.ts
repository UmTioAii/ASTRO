/**
 * Config sharing (F7-4): publica e recupera configs do ASTRO num registry
 * GitHub (Contents API), com versionamento semântico. A config nunca contém
 * segredos (só credentialRef — D-03), e o push valida antes de publicar.
 * baseUrl e fetch são injetáveis: testes rodam contra um registry mock.
 */

/** Registry GitHub: owner/repo onde as configs vivem em configs/<nome>.json */
export interface RegistryOptions {
  owner: string;
  repo: string;
  token: string;
  /** API base; default https://api.github.com (mock em testes). */
  baseUrl?: string;
  fetchLike?: typeof fetch;
}

export class GitHubConfigRegistry {
  readonly #opts: Required<Pick<RegistryOptions, "owner" | "repo" | "token">> & {
    baseUrl: string;
    fetchLike: typeof fetch;
  };

  constructor(opts: RegistryOptions) {
    this.#opts = {
      owner: opts.owner,
      repo: opts.repo,
      token: opts.token,
      baseUrl: (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, ""),
      fetchLike: opts.fetchLike ?? fetch,
    };
  }

  #pathFor(name: string): string {
    return `/repos/${this.#opts.owner}/${this.#opts.repo}/contents/configs/${name}.json`;
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#opts.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "astro-config-share",
    };
  }

  /** Publica o JSON da config; atualiza quando já existe (fluxo sha). */
  async push(name: string, configJson: string): Promise<{ path: string; created: boolean }> {
    const path = this.#pathFor(name);
    const content = btoa(configJson);

    // sha do arquivo atual, quando existe (PUT exige para update)
    let sha: string | undefined;
    let created = true;
    const current = await this.#fetchJson("GET", path);
    if (current.status === 200) {
      const body = current.body as { sha?: unknown };
      if (typeof body.sha === "string") {
        sha = body.sha;
        created = false;
      }
    } else if (current.status !== 404) {
      throw new Error(`registry respondeu HTTP ${current.status} ao ler configs/${name}.json`);
    }

    const response = await this.#fetchJson("PUT", path, {
      message: `astro config push: ${name}`,
      content,
      ...(sha === undefined ? {} : { sha }),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`registry respondeu HTTP ${response.status} ao publicar configs/${name}.json`);
    }
    return { path: `configs/${name}.json`, created };
  }

  /** Recupera o JSON da config publicada. */
  async pull(name: string): Promise<string> {
    const path = this.#pathFor(name);
    const response = await this.#fetchJson("GET", path);
    if (response.status === 404) {
      throw new Error(`config "${name}" não encontrada no registry`);
    }
    if (response.status !== 200) {
      throw new Error(`registry respondeu HTTP ${response.status} ao ler configs/${name}.json`);
    }
    const body = response.body as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") {
      throw new Error(`resposta do registry sem "content"`);
    }
    // GitHub devolve base64 com quebras de linha; o mock devolve limpo
    const normalized = body.content.replace(/\r?\n/g, "");
    try {
      return atob(normalized);
    } catch {
      throw new Error(`content de configs/${name}.json não é base64 válido`);
    }
  }

  async #fetchJson(
    method: "GET" | "PUT",
    path: string,
    requestBody?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let response: Response;
    try {
      response = await this.#opts.fetchLike(`${this.#opts.baseUrl}${path}`, {
        method,
        headers: this.#headers(),
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`falha de rede ao falar com o registry: ${detail}`);
    }
    const text = await response.text();
    let parsedBody: Record<string, unknown> | null = null;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsedBody = null; // corpo não-JSON (ex.: erro de proxy); o status basta
      }
    }
    return { status: response.status, body: parsedBody };
  }
}

/** Valida formato semântico x.y.z (sem prerelease, para simplicidade). */
export function isValidSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** Marcador de origem publicado junto da config (I-13). */
export interface ConfigProvenance {
  registry: string;
  plugins: boolean;
}

function pluginEntries(raw: unknown): string[] {
  const record = raw as { plugins?: unknown };
  return Array.isArray(record.plugins) ? record.plugins.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Prepara a config para push: plugins só são publicados com aprovação explícita,
 * e o JSON publicado leva a proveniência do registry (I-13).
 */
export function prepareConfigForPush(
  raw: unknown,
  registry: string,
  allowPlugins: boolean,
): { ok: true; json: string } | { ok: false; error: string } {
  const plugins = pluginEntries(raw);
  if (plugins.length > 0 && !allowPlugins) {
    return { ok: false, error: `config com plugins (${plugins.join(", ")}) não é publicada sem --allow-plugins` };
  }
  const config = { ...(raw as Record<string, unknown>), provenance: { registry, plugins: plugins.length > 0 } };
  return { ok: true, json: JSON.stringify(config, null, 2) + "\n" };
}

/**
 * Sanitiza a config puxada: plugins só sobrevivem com aprovação explícita;
 * a proveniência fica gravada no arquivo local.
 */
export function preparePulledConfig(
  raw: unknown,
  registry: string,
  allowPlugins: boolean,
): { json: string; removedPlugins: string[] } {
  const plugins = pluginEntries(raw);
  const kept = plugins.length > 0 && allowPlugins;
  const config = { ...(raw as Record<string, unknown>) };
  const removedPlugins = plugins.length > 0 && !allowPlugins ? plugins : [];
  if (removedPlugins.length > 0) delete config.plugins;
  config.provenance = { registry, plugins: kept };
  return { json: JSON.stringify(config, null, 2) + "\n", removedPlugins };
}