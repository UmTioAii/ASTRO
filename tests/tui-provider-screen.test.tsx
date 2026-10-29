import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { ProviderScreen } from "../src/tui/provider-screen";
import { ProfileManager } from "../src/provider/profile-manager";
import { getThemeColors } from "../src/tui/theme";
import { runCommand } from "../src/tui/commands";
import type { ChatSession } from "../src/chat/repl";

const colors = getThemeColors("dark");

function project() {
  return validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function manager() {
  const home = mkdtempSync(join(tmpdir(), "astro-tui-provider-"));
  return new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("lista providers com marcador e origem", async () => {
  const instance = render(
    <ProviderScreen manager={manager()} colors={colors} onClose={() => undefined} onActivate={() => undefined} />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  const frame = instance.lastFrame() ?? "";
  expect(frame).toContain("p (p)");
  expect(frame).toContain("[project]");
  expect(frame).toContain("a adicionar");
  instance.unmount();
});

test("a abre o formulário e salva um provider custom", async () => {
  const m = manager();
  const activated: string[] = [];
  const order: string[] = [];
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={(id) => { activated.push(id); order.push("activate"); }}
      onChanged={() => order.push("changed")}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("De onde partir?") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Nome") === true);
  instance.stdin.write("Local");
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Base URL") === true);
  instance.stdin.write("http://localhost:1/v1");
  await waitFor(() => instance.lastFrame()?.includes("http://localhost:1/v1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Modelos") === true);
  instance.stdin.write("m1");
  await waitFor(() => instance.lastFrame()?.includes("m1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Variável da chave") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Confirmar") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("salvo: local") === true);
  expect(m.list().map((item) => item.id)).toContain("local");
  expect(activated).toContain("local");
  expect(order).toEqual(["changed", "activate"]);
  instance.unmount();
});

test("edit preserva headers e remove confirma", async () => {
  const m = manager();
  const added = m.add({
    name: "Casa",
    kind: "openai-compat",
    baseUrl: "https://casa.example/v1",
    credentialRef: "KEY",
    headers: { "X-Title": "ASTRO" },
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  const edit = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "edit", target: added.id }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => edit.lastFrame()?.includes("Editar casa") === true);
  for (const label of ["Base URL", "Modelos", "Variável da chave", "Confirmar"]) {
    edit.stdin.write("\r");
    await waitFor(() => edit.lastFrame()?.includes(label) === true);
  }
  edit.stdin.write("\r");
  await waitFor(() => edit.lastFrame()?.includes("salvo: casa") === true);
  expect(m.list().find((item) => item.id === "casa")?.headers).toEqual({ "X-Title": "ASTRO" });
  edit.unmount();

  const remove = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "remove", target: "casa" }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => remove.lastFrame()?.includes("Remover Casa?") === true);
  remove.stdin.write("s");
  await waitFor(() => remove.lastFrame()?.includes("removido: casa") === true);
  expect(m.list().some((item) => item.id === "casa")).toBe(false);
  remove.unmount();
});

test("falha de ativação aparece na tela", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => { throw new Error("boom ativação"); }}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("De onde partir?") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Nome") === true);
  instance.stdin.write("Local");
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Base URL") === true);
  instance.stdin.write("http://localhost:1/v1");
  await waitFor(() => instance.lastFrame()?.includes("http://localhost:1/v1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Modelos") === true);
  instance.stdin.write("m1");
  await waitFor(() => instance.lastFrame()?.includes("m1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Variável da chave") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Confirmar") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("não ativado") === true);
  expect(instance.lastFrame()).toContain("boom ativação");
  instance.unmount();
});

test("remove com alvo desconhecido abre a lista, não a confirmação", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      initial={{ mode: "remove", target: "ghost" }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  expect(instance.lastFrame()).toContain("não encontrado");
  expect(instance.lastFrame()).not.toContain("Remover");
  instance.unmount();
});

test("provider do projeto não é removível pela tela", async () => {
  const instance = render(
    <ProviderScreen manager={manager()} colors={colors} onClose={() => undefined} onActivate={() => undefined} />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  instance.stdin.write("d");
  await waitFor(() => instance.lastFrame()?.includes("astro.config.json") === true);
  expect(instance.lastFrame()).toContain("definido no astro.config.json");
  instance.unmount();
});

test("/provider abre a tela pela TUI", async () => {
  const outcome = await runCommand({ kind: "provider", action: "list" }, {} as ChatSession, {});
  expect(outcome.openProviders).toEqual({ mode: "list" });
  const add = await runCommand({ kind: "provider", action: "add" }, {} as ChatSession, {});
  expect(add.openProviders).toEqual({ mode: "add" });
  const edit = await runCommand({ kind: "provider", action: "edit", target: "x" }, {} as ChatSession, {});
  expect(edit.openProviders).toEqual({ mode: "edit", target: "x" });
});
