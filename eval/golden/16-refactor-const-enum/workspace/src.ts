export function label(status: string): string {
  if (status === "active") return "Ativo";
  if (status === "inactive") return "Inativo";
  return "Desconhecido";
}
