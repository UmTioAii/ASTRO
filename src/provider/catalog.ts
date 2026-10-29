/** Catálogo seed de providers: preenche o wizard, não é whitelist. */
import type { ProfileModel } from "./profiles";

export interface CatalogEntry {
  key: string;
  name: string;
  kind: "openai-compat" | "codex-oauth";
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  models: ProfileModel[];
}

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  {
    key: "openai",
    name: "OpenAI",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "OPENAI_API_KEY",
    models: [{ id: "gpt-4o", tags: ["writing-code", "tools"], context: 128000 }],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "OPENROUTER_API_KEY",
    models: [{ id: "openai/gpt-4o-mini", tags: ["writing-code", "tools", "fast"], context: 128000 }],
  },
  {
    key: "nvidia",
    name: "NVIDIA",
    kind: "openai-compat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialRef: "NVIDIA_API_KEY",
    models: [{
      id: "meta/llama-3.3-70b-instruct",
      tags: ["writing-code", "tools", "long-context"],
      context: 131072,
    }],
  },
  {
    key: "ollama",
    name: "Ollama",
    kind: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    models: [{ id: "llama3.1", tags: ["writing-code", "tools"], context: 32768 }],
  },
  {
    key: "codex",
    name: "Codex",
    kind: "codex-oauth",
    credentialsPath: "~/.codex/auth.json",
    models: [{ id: "gpt-5.5", tags: ["writing-code", "tools", "reasoning"], context: 400000 }],
  },
];

export function catalogEntry(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}
