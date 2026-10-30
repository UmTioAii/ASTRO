import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/provider/types";
import { MAX_RELEVANT_FILES, buildCompactionArtifact, renderCompactionArtifact } from "../src/compaction/types";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

describe("CompactionArtifactV1 (S-17, CMP-4)", () => {
  test("preenche as cinco seções a partir do histórico e do resumo", () => {
    const artifact = buildCompactionArtifact({
      run: "r1",
      older: [
        user("tarefa antiga"),
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"src/a.ts\"}" }] },
        { role: "tool", content: "erro: arquivo ausente", toolCallId: "c1" },
      ],
      recent: [user("tarefa atual"), assistant("vou corrigir o parser")],
      summary: "Resumo do histórico antigo.",
    });

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      run: "r1",
      active: "tarefa atual",
      nextMove: "vou corrigir o parser",
      importantContext: "Resumo do histórico antigo.",
    });
    expect(artifact.blocked.join(" ")).toContain("arquivo ausente");
    expect(artifact.relevantFiles).toContain("src/a.ts");
  });

  test("relevantFiles é deduplicado e limitado a 15", () => {
    const toolCalls = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      name: "read_file",
      arguments: JSON.stringify({ path: `src/f${index % 18}.ts` }),
    }));
    const artifact = buildCompactionArtifact({
      run: "r1",
      older: [{ role: "assistant", content: "", toolCalls }],
      recent: [user("u")],
      summary: "s",
    });

    expect(artifact.relevantFiles).toHaveLength(MAX_RELEVANT_FILES);
    expect(new Set(artifact.relevantFiles).size).toBe(artifact.relevantFiles.length);
  });

  test("Blocked é limitado às últimas 5 falhas", () => {
    const older: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: "tool", content: `erro ${index}`, toolCallId: `c${index}`,
    }));
    const artifact = buildCompactionArtifact({ run: "r1", older, recent: [user("u")], summary: "s" });
    expect(artifact.blocked).toHaveLength(5);
    expect(artifact.blocked[0]).toContain("erro 3");
    expect(artifact.blocked.at(-1)).toContain("erro 7");
  });

  test("renderiza as seções como mensagem de sistema estável", () => {
    const text = renderCompactionArtifact({
      schemaVersion: 1,
      run: "r1",
      active: "a",
      blocked: ["b"],
      nextMove: "n",
      relevantFiles: ["x.ts"],
      importantContext: "ctx",
    });
    for (const label of ["Active:", "Blocked:", "Next Move:", "Relevant Files:", "Important Context:"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("CompactionArtifactV1");
  });
});
