export function isPalindrome(s: string): boolean {
  const t = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return t === [...t].reverse().join("");
}
