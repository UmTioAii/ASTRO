import { SkillError, type Skill } from "./types";

function keyOf(skill: Skill): string {
  return `${skill.manifest.source}/${skill.manifest.name}`;
}

/**
 * Registro em memória por `fonte/nome` (C1). A fonte separa `project/commit`
 * de `user/commit`; o nome puro só resolve quando é único.
 */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  register(skill: Skill): void {
    const key = keyOf(skill);
    const existing = this.#skills.get(key);
    if (existing !== undefined) {
      if (
        existing.manifest.version === skill.manifest.version &&
        existing.manifest.sha256 === skill.manifest.sha256
      ) {
        return;
      }
      throw new SkillError(
        `skill "${key}": conflito com a versão ${existing.manifest.version} já registrada`,
      );
    }
    this.#skills.set(key, skill);
  }

  /** Aceita `fonte/nome`; nome puro exige que exista em apenas uma fonte. */
  get(name: string): Skill | undefined {
    const exact = this.#skills.get(name);
    if (exact !== undefined) return exact;
    const matches = this.list().filter((skill) => skill.manifest.name === name);
    if (matches.length > 1) {
      throw new SkillError(`skill "${name}": nome ambíguo; use uma fonte (project/${name} ou user/${name})`);
    }
    return matches[0];
  }

  require(name: string): Skill {
    const skill = this.get(name);
    if (skill === undefined) throw new SkillError(`skill "${name}" não encontrada`);
    return skill;
  }

  list(): Skill[] {
    return [...this.#skills.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, skill]) => skill);
  }

  get size(): number {
    return this.#skills.size;
  }
}
