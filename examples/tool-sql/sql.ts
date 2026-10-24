/**
 * Exemplo de tool usando o ASTRO Tool SDK (F7-3): consulta estilo SQL sobre
 * um arquivo JSON do workspace (~70 linhas). Demonstrates: manifesto I-12,
 * confinamento de caminho (I-11) e resultados de erro como ToolResult.
 *
 * Uso: o modelo chama sql_query { file: "dados.json", where: { column: "idade", equals: 30 } }
 * Plugin:
 *   export function definePlugin() {
 *     return { name: "astro-tool-sql", tools: [sqlTool] };
 *   }
 */
import { defineTool, toolFailure, toolSuccess } from "../../src/sdk/tool";

interface SqlInput {
  file: string;
  where?: { column: string; equals: unknown };
  limit?: number;
}

export const sqlTool = defineTool(
  {
    name: "sql_query",
    description:
      "Consulta linhas de um arquivo JSON do workspace. Suporta filtro por igualdade (where) e limite.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Caminho do JSON, relativo ao cwd." },
        where: {
          type: "object",
          description: "Filtro de igualdade: { column, equals }.",
          properties: { column: { type: "string" }, equals: {} },
        },
        limit: { type: "number", description: "Máximo de linhas (default 100)." },
      },
      required: ["file"],
    },
    risk: "medium",
    permission: "execute",
    timeoutMs: 10_000,
    retryable: true,
  },
  async (input, ctx) => {
    const parsed = input as SqlInput;
    if (typeof parsed?.file !== "string" || parsed.file.length === 0) {
      return toolFailure('sql_query: campo "file" (string) é obrigatório');
    }

    // Confina o caminho ao cwd (I-11)
    const { resolveWithin } = await import("../../src/tools/paths");
    let path: string;
    try {
      path = resolveWithin(ctx.cwd, parsed.file);
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : String(error));
    }

    let rows: unknown;
    try {
      rows = JSON.parse(await Bun.file(path).text());
    } catch (error) {
      return toolFailure(`sql_query: não foi possível ler ${parsed.file} como JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!Array.isArray(rows)) {
      return toolFailure(`sql_query: ${parsed.file} não contém uma lista de linhas`);
    }

    const where = parsed.where;
    const filtered = where
      ? rows.filter(
          (row) =>
            typeof row === "object" &&
            row !== null &&
            (row as Record<string, unknown>)[where.column] === where.equals,
        )
      : rows;

    const limit = typeof parsed.limit === "number" && parsed.limit > 0 ? parsed.limit : 100;
    return toolSuccess(JSON.stringify(filtered.slice(0, limit)));
  },
);