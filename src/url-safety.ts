/** Validação de URL de provider compartilhada por config e store (I-03). */

const SENSITIVE_QUERY = /^(api[-_]?key|key|token|access[-_]?token|secret)$/i;

/** Hosts de metadados de nuvem conhecidos (nunca são destinos legítimos). */
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "instance-data"]);

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function ipv4Private(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function ipv6Private(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  const mapped = /^::ffff:(.+)$/.exec(lower);
  if (mapped !== null) return ipv4Private(mapped[1]!);
  return false;
}

function isMetadataOrLinkLocal(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (METADATA_HOSTS.has(host) || METADATA_HOSTS.has(bare)) return true;
  if (ipv4Private(bare)) {
    const [a, b] = bare.split(".").map(Number) as [number, number, number, number];
    if ((a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return bare.toLowerCase().startsWith("fe8")
    || bare.toLowerCase().startsWith("fe9")
    || bare.toLowerCase().startsWith("fea")
    || bare.toLowerCase().startsWith("feb");
}

function isPrivateHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  return ipv4Private(bare) || ipv6Private(bare);
}

/** Opt-in explícito para destinos privados em desenvolvimento local. */
export function privateUrlsAllowed(): boolean {
  return process.env.ASTRO_ALLOW_PRIVATE_URLS === "1";
}

export function urlProblem(raw: string): string | undefined {
  const url = parse(raw);
  if (url === undefined) return "não é uma URL http(s) válida";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "não é uma URL http(s) válida";
  if (url.username !== "" || url.password !== "") return "não pode embutir credencial; use credentialRef";
  if (isMetadataOrLinkLocal(url)) {
    return "aponta para host de metadados ou link-local; destino recusado";
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      return `não pode levar credencial na query (${key}); use credentialRef`;
    }
  }
  return undefined;
}

/**
 * URL de saída que recebe dado do harness (webhook, telemetria, MCP, instalação
 * de skill). Além das regras de `urlProblem`, recusa loopback e faixas privadas
 * para evitar SSRF/exfiltração; `allowPrivate` (opt-in de dev) libera apenas
 * loopback/RFC1918, nunca metadados.
 */
export function outboundUrlProblem(raw: string, opts: { allowPrivate?: boolean } = {}): string | undefined {
  const base = urlProblem(raw);
  if (base !== undefined) return base;
  const url = parse(raw)!;
  const allowPrivate = opts.allowPrivate ?? privateUrlsAllowed();
  if (allowPrivate) return undefined;
  if (isPrivateHost(url)) return "aponta para host privado ou loopback; destino recusado";
  return undefined;
}
