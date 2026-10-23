export function loadConfig(path: string): Promise<unknown> {
  return fetch(path)
    .then((r) => r.text())
    .then((t) => JSON.parse(t));
}
