const supportedLoginFlags = new Set(["--json", "--no-browser", "--oauth", "--verbose"]);

export interface ZaiOAuthInvocation {
  json: boolean;
  noBrowser: boolean;
  runtimeArgs: string[];
}

export function classifyZaiOAuthInvocation(args: string[]): ZaiOAuthInvocation | null {
  const positionals = args.filter((argument) => !argument.startsWith("-"));
  if (positionals.length !== 1 || positionals[0] !== "login") return null;
  if (args.some((argument) => argument.startsWith("-") && !supportedLoginFlags.has(argument))) {
    return null;
  }
  return {
    json: args.includes("--json"),
    noBrowser: args.includes("--no-browser"),
    runtimeArgs: args.filter((argument) => argument !== "--oauth")
  };
}
