import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SKILL_NAME_RE,
  SkillError,
  type Skill,
  type SkillFilesystem,
  type SkillScript,
  type SkillSource,
} from "./types";

type YamlMap = Record<string, unknown>;

function isRecord(value: unknown): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value === "[]") return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter((item) => item !== "");
  }
  const quote = value.charAt(0);
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

interface YamlFrame {
  indent: number;
  value: YamlMap | unknown[];
}

interface YamlLine {
  indent: number;
  trimmed: string;
}

function nextContentLine(lines: readonly string[], start: number): YamlLine | undefined {
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return { indent: raw.length - raw.trimStart().length, trimmed };
  }
  return undefined;
}

/** Parser YAML mínimo do frontmatter: mapas, listas, escalares e arrays inline. */
function parseYaml(text: string): YamlMap {
  const root: YamlMap = {};
  const stack: YamlFrame[] = [{ indent: -1, value: root }];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const frame = stack.at(-1)!;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(frame.value)) throw new SkillError("frontmatter inválido: lista sem chave");
      const item = trimmed.slice(2).trim();
      const colon = item.indexOf(":");
      if (colon >= 0) {
        const object: YamlMap = {};
        object[item.slice(0, colon).trim()] = parseScalar(item.slice(colon + 1));
        frame.value.push(object);
        stack.push({ indent, value: object });
      } else {
        frame.value.push(parseScalar(item));
      }
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) throw new SkillError(`frontmatter inválido: esperado "chave: valor" em "${trimmed}"`);
    const key = trimmed.slice(0, colon).trim();
    if (key === "") throw new SkillError("frontmatter inválido: chave vazia");
    if (!isRecord(frame.value)) throw new SkillError(`frontmatter inválido: "${key}" dentro de lista`);

    const rawValue = trimmed.slice(colon + 1).trim();
    if (rawValue !== "") { frame.value[key] = parseScalar(rawValue); continue; }

    const next = nextContentLine(lines, index + 1);
    const child: YamlMap | unknown[] =
      next !== undefined && next.indent > indent && next.trimmed.startsWith("- ") ? [] : {};
    frame.value[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function requiredString(data: YamlMap, key: string, label: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SkillError(`skill "${label}": "${key}" obrigatório`);
  }
  return value.trim();
}

function parsePermissions(raw: unknown, label: string): Skill["manifest"]["permissions"] {
  if (raw === undefined) return { tools: [], network: false, filesystem: "none" };
  if (!isRecord(raw)) throw new SkillError(`skill "${label}": "permissions" deve ser um objeto`);

  const rawTools = raw.tools ?? [];
  if (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new SkillError(`skill "${label}": "permissions.tools" deve ser uma lista de nomes`);
  }
  const network = raw.network ?? false;
  if (typeof network !== "boolean") throw new SkillError(`skill "${label}": "permissions.network" deve ser booleano`);
  const filesystem = raw.filesystem ?? "none";
  if (filesystem !== "none" && filesystem !== "read" && filesystem !== "write") {
    throw new SkillError(`skill "${label}": "permissions.filesystem" deve ser none, read ou write`);
  }
  return {
    tools: rawTools.map((tool) => (tool as string).trim()),
    network,
    filesystem: filesystem as SkillFilesystem,
  };
}

function parseScripts(raw: unknown, label: string): SkillScript[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new SkillError(`skill "${label}": "scripts" deve ser uma lista`);
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new SkillError(`skill "${label}": script ${index + 1} deve ser um objeto`);
    return {
      name: requiredString(item, "name", `${label}/script ${index + 1}`),
      command: requiredString(item, "command", `${label}/script ${index + 1}`),
    };
  });
}

/** Parseia o conteúdo de um SKILL.md; `path` é o caminho absoluto do arquivo. */
export function parseSkill(content: string, source: SkillSource, path: string): Skill {
  const text = content.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (match === null) throw new SkillError(`skill "${path}": frontmatter YAML ausente ou não fechado`);

  const data = parseYaml(match[1]!);
  const label = typeof data.name === "string" ? data.name : path;
  const name = requiredString(data, "name", label);
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillError(`skill "${label}": "name" inválido; use letras minúsculas, números, "-" ou "_"`);
  }
  const description = requiredString(data, "description", name);
  const version = requiredString(data, "version", name);
  const prompt = match[2]!.trim();
  if (prompt === "") throw new SkillError(`skill "${name}": prompt vazio`);

  return {
    manifest: {
      name,
      description,
      version,
      permissions: parsePermissions(data.permissions, name),
      scripts: parseScripts(data.scripts, name),
      source,
      path: resolve(path),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    prompt,
  };
}

export function loadSkillFile(path: string, source: SkillSource): Skill {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new SkillError(`skill "${absolute}": arquivo não encontrado`);
  return parseSkill(readFileSync(absolute, "utf8"), source, absolute);
}

/**
 * Carrega `<root>/<nome>/SKILL.md`. Skill inválida vira warn e não derruba as
 * demais; `root` ausente é uma lista vazia (fonte opcional).
 */
export function loadSkillsFromRoot(
  root: string,
  source: SkillSource,
  warn: (message: string) => void = () => {},
): Skill[] {
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];

  const skills: Skill[] = [];
  const entries = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = join(absolute, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      skills.push(loadSkillFile(file, source));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn(`skill "${entry.name}" ignorada: ${detail}`);
    }
  }
  return skills;
}
