export async function fetchUser(id: string): Promise<{ id: string }> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}
