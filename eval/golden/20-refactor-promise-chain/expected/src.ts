export async function loadConfig(path: string): Promise<unknown> {
  const r = await fetch(path);
  const t = await r.text();
  return JSON.parse(t);
}
