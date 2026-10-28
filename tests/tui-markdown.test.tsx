import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Markdown, inlineSegments, markdownLines } from "../src/tui/markdown";

describe("markdown da TUI (T2, #63)", () => {
  test("classifica títulos, listas e blocos de código", () => {
    const lines = markdownLines("# Título\n- item\n```\nconst x = 1;\n**não é negrito**\n```\ntexto");
    expect(lines).toEqual([
      { kind: "heading", text: "Título" },
      { kind: "bullet", text: "item" },
      { kind: "code", text: "const x = 1;" },
      { kind: "code", text: "**não é negrito**" },
      { kind: "text", text: "texto" },
    ]);
  });

  test("separa negrito e código inline", () => {
    expect(inlineSegments("a **b** c `d`")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c " },
      { text: "d", code: true },
    ]);
  });

  test("renderiza sem as marcas de markdown e mantém o código", () => {
    const { lastFrame, unmount } = render(<Markdown text={"## Título\n**forte** e `code`\n```\nlinha()\n```"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Título");
    expect(frame).toContain("forte");
    expect(frame).toContain("code");
    expect(frame).toContain("linha()");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("```");
    unmount();
  });


test("remove escapes ANSI e controle do texto do modelo", () => {
  const lines = markdownLines("\u001b[31mvermelho\u001b[0m e \u0007bipe");
  expect(lines).toEqual([{ kind: "text", text: "vermelho e bipe" }]);
});

test("preserva parágrafos e texto puro", () => {
  expect(markdownLines("um\n\n dois")).toEqual([
    { kind: "text", text: "um" },
    { kind: "blank" },
    { kind: "text", text: " dois" },
  ]);
  expect(markdownLines("sem marcas")).toEqual([{ kind: "text", text: "sem marcas" }]);
});

test("negrito com código aninhado e heading inline", () => {
  expect(inlineSegments("**use `x` aqui**")).toEqual([
    { text: "use ", bold: true },
    { text: "x", code: true, bold: true },
    { text: " aqui", bold: true },
  ]);
  const { lastFrame, unmount } = render(<Markdown text={"## `astro`"} />);
  expect(lastFrame()).toContain("astro");
  expect(lastFrame()).not.toContain("`");
  unmount();
});

test("cerca maior protege exemplo de Markdown e OSC é removido", () => {
  expect(markdownLines("````md\n```js\ncode\n```\n````")).toEqual([
    { kind: "code", text: "```js" },
    { kind: "code", text: "code" },
    { kind: "code", text: "```" },
  ]);
  expect(markdownLines("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toEqual([{ kind: "text", text: "link" }]);
});

test("entrada vazia e quebra final não geram linhas em branco", () => {
  expect(markdownLines("")).toEqual([]);
  expect(markdownLines("oi\n")).toEqual([{ kind: "text", text: "oi" }]);
});});
