export type AppServerAuthMode = "standalone" | "host";

/** Choose the credential owner once when the protocol registry starts. */
export function appServerAuthMode(env: NodeJS.ProcessEnv): AppServerAuthMode {
  const mode = env.ZCODE_APP_SERVER_AUTH_MODE?.trim() || "standalone";
  if (mode !== "standalone" && mode !== "host") {
    throw new Error("ZCODE_APP_SERVER_AUTH_MODE must be standalone or host.");
  }
  return mode;
}

/** Host mode retains native account updates and client-driven request auth. */
export function appServerRegistryOptions<T extends object>(
  env: NodeJS.ProcessEnv,
  createRefreshReporter: (stderr: NodeJS.WriteStream) => T
): { standalone?: T } {
  return appServerAuthMode(env) === "host" ? {} : { standalone: createRefreshReporter(process.stderr) };
}
