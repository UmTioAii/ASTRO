export function sortByAge(people: Array<{ name: string; age: number }>): Array<{ name: string; age: number }> {
  return [...people].sort((a, b) => a.age - b.age);
}
