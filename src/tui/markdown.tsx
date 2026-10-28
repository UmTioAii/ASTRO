/** Markdown mínimo para o painel: títulos, listas e blocos de código, sem dependências. */
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export type MarkdownLine =
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "code"; text: string }
  | { kind: "blank" };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
// Modelo pode devolver escapes ANSI/controle: não deixamos vazar para o terminal.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const FENCE = /^(`{3,}|~{3,})/;

/** Converte o texto em linhas tipadas; cercas ``` viram linhas de código. */
export function markdownLines(markdown: string): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").replace(CONTROL, "").trimEnd();
    const marker = FENCE.exec(line.trimStart());
    if (marker !== null) {
      const token = marker[1]!;
      if (fence === undefined) {
        fence = { char: token[0]!, length: token.length };
        continue;
      }
      if (token[0] === fence.char && token.length >= fence.length) {
        fence = undefined;
        continue;
      }
    }
    if (fence !== undefined) {
      out.push({ kind: "code", text: line });
      continue;
    }
    if (line.trim() === "") {
      out.push({ kind: "blank" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      out.push({ kind: "bullet", text: bullet[1]! });
      continue;
    }
    out.push({ kind: "text", text: line });
  }
  while (out.at(-1)?.kind === "blank") out.pop();
  while (out[0]?.kind === "blank") out.shift();
  return out;
}

/** Divide uma linha em texto, **negrito** e `código` (inclusive aninhados). */
export function inlineSegments(text: string): Array<{ text: string; bold?: boolean; code?: boolean }> {
  return parseInline(text, false);
}

function parseInline(text: string, bold: boolean): Array<{ text: string; bold?: boolean; code?: boolean }> {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  const out: Array<{ text: string; bold?: boolean; code?: boolean }> = [];
  for (const part of parts) {
    if (part === "") continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      out.push(...parseInline(part.slice(2, -2), true));
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push({ text: part.slice(1, -1), code: true, ...(bold ? { bold: true } : {}) });
      continue;
    }
    out.push({ text: part, ...(bold ? { bold: true } : {}) });
  }
  return out;
}

function Inline({ text }: { text: string }): ReactElement {
  const segments = inlineSegments(text);
  return (
    <Text>
      {segments.map((segment, index) => (
        <Text key={index} {...(segment.bold === true ? { bold: true } : {})} {...(segment.code === true ? { color: "cyan" } : {})}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/** Renderiza o Markdown no painel; blocos de código ganham uma caixa. */
export function Markdown({ text }: { text: string }): ReactElement {
  const lines = markdownLines(text);
  const blocks: ReactElement[] = [];
  let code: string[] = [];
  const flush = (): void => {
    if (code.length === 0) return;
    blocks.push(
      <Box key={`code-${blocks.length}`} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        {code.map((line, index) => <Text key={index}>{line}</Text>)}
      </Box>,
    );
    code = [];
  };
  for (const line of lines) {
    if (line.kind === "code") {
      code.push(line.text);
      continue;
    }
    flush();
    if (line.kind === "heading") {
      blocks.push(<Text key={blocks.length} bold color="cyan"><Inline text={line.text} /></Text>);
    } else if (line.kind === "bullet") {
      blocks.push(<Text key={blocks.length}>{"• "}<Inline text={line.text} /></Text>);
    } else if (line.kind === "blank") {
      blocks.push(<Text key={blocks.length}> </Text>);
    } else {
      blocks.push(<Inline key={blocks.length} text={line.text} />);
    }
  }
  flush();
  return <Box flexDirection="column">{blocks}</Box>;
}
