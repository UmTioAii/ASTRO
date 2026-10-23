export interface GreetOptions {
  punctuation: string;
  upper: boolean;
}

export function makeGreeter(options: GreetOptions) {
  return (name: string): string => {
    const msg = `olá ${name}${options.punctuation}`;
    return options.upper ? msg.toUpperCase() : msg;
  };
}
