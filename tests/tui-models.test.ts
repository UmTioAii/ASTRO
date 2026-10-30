import { expect, test } from "bun:test";
import {
  filterModels,
  modelDetail,
  orderModels,
  recordRecent,
  toggleFavorite,
  type ModelOption,
} from "../src/tui/models";

const model = (id: string, provider = "p", tags: string[] = [], context = 8192): ModelOption => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  tags,
  context,
  status: "active",
});

test("filtra por id, provider e tag sem diferenciar maiúsculas", () => {
  const models = [model("gpt-4o", "openai", ["writing-code"]), model("llama-3", "nvidia", ["fast"])];
  expect(filterModels(models, "").map((item) => item.ref)).toEqual(["openai/gpt-4o", "nvidia/llama-3"]);
  expect(filterModels(models, "GPT").map((item) => item.ref)).toEqual(["openai/gpt-4o"]);
  expect(filterModels(models, "nvidia").map((item) => item.ref)).toEqual(["nvidia/llama-3"]);
  expect(filterModels(models, "writing").map((item) => item.ref)).toEqual(["openai/gpt-4o"]);
  expect(filterModels(models, "nada")).toEqual([]);
});

test("ordena favoritos, recentes e o resto, descartando refs desconhecidas", () => {
  const models = [model("a"), model("b"), model("c"), model("d")];
  expect(orderModels(models, ["p/c"], ["p/b", "p/ghost"]).map((item) => item.id)).toEqual(["c", "b", "a", "d"]);
  expect(orderModels(models, ["p/ghost"], []).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
});

test("recente vai para a frente, sem duplicar e limitado a 10", () => {
  expect(recordRecent("p/a", ["p/b", "p/c"])).toEqual(["p/a", "p/b", "p/c"]);
  expect(recordRecent("p/b", ["p/b", "p/c"])).toEqual(["p/b", "p/c"]);
  const many = Array.from({ length: 10 }, (_, index) => `p/m${index}`);
  expect(recordRecent("p/new", many)).toHaveLength(10);
  expect(recordRecent("p/new", many)[0]).toBe("p/new");
});

test("favorito alterna sem duplicar e preserva a ordem", () => {
  expect(toggleFavorite("p/a", [])).toEqual(["p/a"]);
  expect(toggleFavorite("p/b", ["p/a"])).toEqual(["p/a", "p/b"]);
  expect(toggleFavorite("p/a", ["p/a", "p/b"])).toEqual(["p/b"]);
});

test("detalhe mostra contexto, tags e preço curado ou n/d", () => {
  const priced = {
    ...model("a", "p", ["writing-code", "tools"], 128000),
    price: { inputPerM: 1, outputPerM: 2, fonte: "vendor", verificado: true },
  };
  const text = modelDetail(priced);
  expect(text).toContain("p/a");
  expect(text).toContain("128000");
  expect(text).toContain("writing-code");
  expect(text).toContain("in 1");
  expect(text).toContain("out 2");
  expect(modelDetail(model("b"))).toContain("n/d");
});
