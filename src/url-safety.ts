/** Validação de URL de provider compartilhada por config e store (I-03). */

const SENSITIVE_QUERY = /^(api[-_]?key|key|token|access[-_]?token|secret)$/i;

export function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "não é uma URL http(s) válida";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "não é uma URL http(s) válida";
  if (url.username !== "" || url.password !== "") return "não pode embutir credencial; use credentialRef";
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      return `não pode levar credencial na query (${key}); use credentialRef`;
    }
  }
  return undefined;
}
