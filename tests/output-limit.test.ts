import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveOutputCap, limitToolOutput } from "../src/output-limit";

const dir = () => mkdtempSync(join(tmpdir(), "astro-output-limit-"));

function bigOutput(lines = 400, lineLength = 60): string {
  return Array.from({ length: lines }, (_, index) =>
    `linha ${String(index + 1).padStart(3, "0")} ${"x".repeat(lineLength)}`).join("\n") + "\n";
}

describe("limite de saída por tool (S-16, CMP-10)", () => {
  test("cap efetivo é min(maxTokens, 5% da janela), com defaults 8000/0,05", () => {
    expect(effectiveOutputCap(undefined, 200_000)).toBe(8000);
    expect(effectiveOutputCap(undefined, 100_000)).toBe(5000);
    expect(effectiveOutputCap({ maxTokens: 1000, shareOfWindow: 0.5 }, 100_000)).toBe(1000);
    expect(effectiveOutputCap({ maxTokens: 1000, shareOfWindow: 0.5 }, 1_000)).toBe(500);
    expect(effectiveOutputCap(undefined, undefined)).toBe(8000);
    expect(effectiveOutputCap(undefined, 0)).toBe(8000);
  });

  test("saída abaixo do cap passa intacta e não cria artefato", () => {
    const artifactDir = dir();
    const result = limitToolOutput("curto", { capTokens: 100, toolCallId: "c1", artifactDir });
    expect(result).toEqual({ output: "curto", truncated: false });
  });

  test("saída acima do cap vira arquivo com head, tail e referência de origem", () => {
    const artifactDir = dir();
    const output = bigOutput();
    const result = limitToolOutput(output, { capTokens: 100, toolCallId: "call-1", artifactDir });

    expect(result.truncated).toBe(true);
    expect(result.unrecoverable).toBeUndefined();
    expect(result.artifactPath).toBeDefined();
    expect(readFileSync(result.artifactPath!, "utf8")).toContain("linha 400");

    const text = result.output;
    expect(text).toContain("saída truncada");
    expect(text).toContain("limite 100");
    expect(text).toContain(`tool_call=call-1`);
    expect(text).toContain(".txt");
    expect(text).toContain("linhas omitidas");
    expect(text).toContain("linha 001"); // head
    expect(text).toContain("linha 400"); // tail
    expect(text).not.toContain("linha 200"); // meio não entra no contexto
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(Buffer.byteLength(output, "utf8"));
  });

  test("origem irrecuperável devolve head+tail com truncated_unrecoverable", () => {
    const result = limitToolOutput(bigOutput(), {
      capTokens: 100,
      toolCallId: "call-2",
      artifactDir: dir(),
      writeArtifact: () => {
        throw new Error("disco cheio");
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.unrecoverable).toBe(true);
    expect(result.artifactPath).toBeUndefined();
    expect(result.output).toContain("truncated_unrecoverable");
    expect(result.output).toContain("tool_call=call-2");
    expect(result.output).toContain("linha 001");
    expect(result.output).toContain("linha 400");
  });

  test("segredo é sanitizado antes do contexto e do artefato (I-03)", () => {
    const artifactDir = dir();
    const secret = "sk-live-0123456789abcdef";
    const output = `${secret}\n${bigOutput(20)}`;
    const result = limitToolOutput(output, { capTokens: 50, toolCallId: "c3", artifactDir });

    expect(result.output).not.toContain(secret);
    const artifact = readFileSync(result.artifactPath!, "utf8");
    expect(artifact).not.toContain(secret);
    expect(artifact).toContain("[REDACTED]");
  });

  test("nome do artefato é determinístico por conteúdo e chamada", () => {
    const artifactDir = dir();
    const output = bigOutput();
    const a = limitToolOutput(output, { capTokens: 100, toolCallId: "c4", artifactDir });
    const b = limitToolOutput(output, { capTokens: 100, toolCallId: "c4", artifactDir });
    const c = limitToolOutput(`${output}extra`, { capTokens: 100, toolCallId: "c4", artifactDir });

    expect(a.artifactPath).toBe(b.artifactPath);
    expect(a.artifactPath).not.toBe(c.artifactPath);
  });
});
