/** CRUD de perfis de provider: store global + visão do projeto, com guardas. */
import type { AstroConfig, ProviderConfig } from "../config";
import {
  loadProfileStore,
  profileFromEnv,
  profilesPath,
  saveProfileStore,
  type ProfileModel,
  type ProviderProfile,
  type ProviderSource,
  type ProviderStore,
} from "./profiles";

export interface ProfileDraft {
  name: string;
  kind: string;
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  headers?: Record<string, string>;
  models: ProfileModel[];
}

export interface ProfileView extends ProviderProfile {
  active: boolean;
  source: ProviderSource;
}

export interface ProfileManagerOptions {
  storePath?: string;
  project?: AstroConfig;
  env?: NodeJS.ProcessEnv;
}

function slug(name: string): string {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const id = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (id === "") throw new Error("nome do provider precisa ter ao menos uma letra ou número");
  return id;
}

function providerOfModel(modelRef: string, providers: Record<string, ProviderConfig>): string | undefined {
  return Object.keys(providers)
    .sort((a, b) => b.length - a.length)
    .find((name) => modelRef.startsWith(`${name}/`));
}

function projectReferences(project: AstroConfig, id: string): string | undefined {
  if (providerOfModel(project.agent.model, project.providers) === id) return "agent.model";
  for (const [name, agent] of Object.entries(project.agents ?? {})) {
    if (providerOfModel(agent.model, project.providers) === id) return `agents.${name}.model`;
  }
  if (project.models.some((model) => model.provider === id)) return "models[].provider";
  for (const [name, profile] of Object.entries(project.modelPool ?? {})) {
    if (providerOfModel(profile.model, project.providers) === id) return `modelPool.${name}.model`;
  }
  for (const [name, provider] of Object.entries(project.providers)) {
    if ((provider.fallback ?? []).includes(id)) return `providers.${name}.fallback`;
  }
  return undefined;
}

export class ProfileManager {
  readonly #storePath: string;
  readonly #project: AstroConfig | undefined;
  readonly #env: NodeJS.ProcessEnv;
  #store: ProviderStore;

  constructor(opts: ProfileManagerOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#project = opts.project;
    this.#storePath = opts.storePath ?? profilesPath(this.#env);
    this.#store = loadProfileStore(this.#storePath);
  }

  list(): ProfileView[] {
    const envProfile = profileFromEnv(this.#env);
    const projectProvider = this.#project === undefined
      ? undefined
      : providerOfModel(this.#project.agent.model, this.#project.providers);
    const activeId = this.#store.activeProfileId ?? projectProvider ?? envProfile?.id;
    const view = (profile: ProviderProfile, source: ProviderSource): ProfileView => ({
      ...profile,
      source,
      active: profile.id === activeId,
    });

    const result = new Map<string, ProfileView>();
    if (this.#project !== undefined) {
      for (const [name, provider] of Object.entries(this.#project.providers)) {
        result.set(name, view(this.#projectProfile(name, provider), "project"));
      }
    }
    for (const profile of this.#store.profiles) {
      if (!result.has(profile.id)) result.set(profile.id, view(profile, "global"));
    }
    if (envProfile !== undefined && !result.has(envProfile.id)) {
      result.set(envProfile.id, view(envProfile, "env"));
    }
    return [...result.values()];
  }

  add(draft: ProfileDraft): ProfileView {
    const name = draft.name.trim();
    if (this.#project !== undefined && Object.hasOwn(this.#project.providers, name)) {
      throw new Error(`provider "${name}" está definido no astro.config.json; edite o arquivo`);
    }
    const id = slug(name);
    if (this.#project !== undefined && Object.hasOwn(this.#project.providers, id)) {
      throw new Error(`provider "${name}" está definido no astro.config.json; edite o arquivo`);
    }
    if (this.#store.profiles.some((profile) => profile.id === id)) {
      throw new Error(`já existe um provider com esse nome: "${name}"`);
    }
    const profile: ProviderProfile = { id, ...draft, name };
    this.#save({ ...this.#store, profiles: [...this.#store.profiles, profile] });
    return { ...profile, active: false, source: "global" };
  }

  edit(id: string, draft: ProfileDraft): ProfileView {
    this.#requireEditable(id);
    const index = this.#store.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`provider "${id}" não existe no store`);
    const profile: ProviderProfile = { ...draft, id, name: draft.name.trim() };
    const profiles = [...this.#store.profiles];
    profiles[index] = profile;
    this.#save({ ...this.#store, profiles });
    return { ...profile, active: this.#store.activeProfileId === id, source: "global" };
  }

  remove(id: string): void {
    this.#requireEditable(id);
    const index = this.#store.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error(`provider "${id}" não existe no store`);
    const reference = this.#project === undefined ? undefined : projectReferences(this.#project, id);
    if (reference !== undefined) {
      throw new Error(`provider "${id}" é usado por astro.config.json (${reference}); troque a referência antes`);
    }
    const { activeProfileId, ...rest } = this.#store;
    const profiles = this.#store.profiles.filter((profile) => profile.id !== id);
    this.#save(activeProfileId === id ? { ...rest, profiles } : { ...rest, profiles, activeProfileId });
  }

  use(id: string): ProviderProfile {
    this.#requireEditable(id);
    const profile = this.#store.profiles.find((item) => item.id === id);
    if (profile === undefined) throw new Error(`provider "${id}" não existe no store`);
    this.#save({ ...this.#store, activeProfileId: id });
    return profile;
  }

  #requireEditable(id: string): void {
    if (this.#project !== undefined && Object.hasOwn(this.#project.providers, id)) {
      throw new Error(`provider "${id}" está definido no astro.config.json; edite o arquivo`);
    }
    if (profileFromEnv(this.#env)?.id === id) {
      throw new Error(`perfil "${id}" é efêmero (env) e não pode ser editado`);
    }
  }

  #projectProfile(name: string, provider: ProviderConfig): ProviderProfile {
    const config = provider as {
      baseUrl?: string;
      credentialRef?: string;
      credentialsPath?: string;
      quotaDomain?: string;
      headers?: Record<string, string>;
    };
    const models = (this.#project?.models ?? [])
      .filter((model) => model.provider === name)
      .map((model) => ({ id: model.id, tags: model.tags, context: model.context }));
    return {
      id: name,
      name,
      kind: provider.kind,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
      ...(config.credentialsPath === undefined ? {} : { credentialsPath: config.credentialsPath }),
      ...(config.quotaDomain === undefined ? {} : { quotaDomain: config.quotaDomain }),
      ...(config.headers === undefined ? {} : { headers: config.headers }),
      models,
    };
  }

  #save(store: ProviderStore): void {
    saveProfileStore(store, this.#storePath);
    this.#store = store;
  }
}
