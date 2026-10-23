export type Status = "active" | "inactive";

export function label(status: Status | string): string {
  if (status === "active") return "Ativo";
  if (status === "inactive") return "Inativo";
  return "Desconhecido";
}
