/** Faz parse de JSON; devolve null quando o texto é inválido. */
export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
