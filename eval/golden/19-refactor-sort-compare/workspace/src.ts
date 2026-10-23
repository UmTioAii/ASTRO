export function sortByAge(people: Array<{ name: string; age: number }>): Array<{ name: string; age: number }> {
  const out = [...people];
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length - 1; j++) {
      if (out[j]!.age > out[j + 1]!.age) {
        [out[j], out[j + 1]] = [out[j + 1]!, out[j]!];
      }
    }
  }
  return out;
}
