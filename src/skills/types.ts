/** Manifesto e tipos de skill (C1/#55), sem dependência de runtime. */

export type SkillSource = "project" | "user";

export type SkillFilesystem = "none" | "read" | "write";

export interface SkillPermissions {
  /** Tools que a skill pede; precisam estar na allowlist do agent (I-01). */
  tools: string[];
  network: boolean;
  filesystem: SkillFilesystem;
}

export interface SkillScript {
  name: string;
  command: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  permissions: SkillPermissions;
  scripts: SkillScript[];
  source: SkillSource;
  /** Caminho absoluto do SKILL.md. */
  path: string;
  /** sha256 do conteúdo do SKILL.md. */
  sha256: string;
}

export interface Skill {
  manifest: SkillManifest;
  /** Corpo markdown após o frontmatter. */
  prompt: string;
}

/** Nome seguro para diretório e namespace (`project/commit`). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Teto de bytes por SKILL.md na leitura e na instalação (C1c). */
export const SKILL_MAX_BYTES = 1_000_000;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}
