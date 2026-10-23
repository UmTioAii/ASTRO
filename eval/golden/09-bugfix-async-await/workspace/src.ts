export async function fetchUser(id: string): Promise<{ id: string }> {
  const response = fetch(`/api/users/${id}`);
  return response.then((r) => r.json());
}
