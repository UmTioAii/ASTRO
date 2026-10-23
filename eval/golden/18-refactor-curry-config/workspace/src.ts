export function greet(name: string, punctuation: string, upper: boolean): string {
  const msg = `olá ${name}${punctuation}`;
  return upper ? msg.toUpperCase() : msg;
}
