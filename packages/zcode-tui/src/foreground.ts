import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

import { suppressTuiAiSdkWarnings } from "./ai-sdk-warnings.ts";
import { RuntimeRpc } from "./runtime-rpc.ts";
import { loadTuiStartupOptions } from "./startup.ts";
import { isRecord, type TuiOptions } from "./types.ts";

export interface ForegroundRuntimeTransport {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ForegroundTuiOptions {
  version?: string;
  workspaceDirectory?: string;
  prepare: (signal: AbortSignal) => Promise<ForegroundRuntimeTransport>;
  onDiagnostic: (chunk: Buffer | string) => void;
}

export async function runForegroundTui(options: ForegroundTuiOptions): Promise<number> {
  suppressTuiAiSdkWarnings();
  const lifecycle = new AbortController();
  let child: ChildProcess | undefined;
  let peer: RuntimeRpc | undefined;
  let exited: Promise<number> | undefined;
  let failure: Error | undefined;
  let closing = false;
  let signalCode: number | undefined;
  let forceTermination: ReturnType<typeof setTimeout> | undefined;
  let backendReady = false;
  let completedNormally = false;
  const inheritedEnvironment = new Map<string, string | undefined>();
  const fail = (error: Error) => {
    if (closing || lifecycle.signal.aborted) return;
    failure = error;
    lifecycle.abort(error);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    signalCode = 128 + (osConstants.signals[signal] ?? 0);
    lifecycle.abort(signal);
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const onSighup = () => onSignal("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.on("SIGHUP", onSighup);

  let implementation: typeof import("./index.ts") | undefined;
  let readyOptions: TuiOptions | undefined;
  try {
    readyOptions = await loadTuiStartupOptions({
      version: options.version,
      workspaceDirectory: options.workspaceDirectory,
      startupEditor: true,
      runtimeSignal: lifecycle.signal,
      submitPrompt: async () => { throw new Error("The runtime is not ready."); },
      loadStartupOptions: async () => {
        const backend = async (): Promise<TuiOptions> => {
          const transport = await options.prepare(lifecycle.signal);
          lifecycle.signal.throwIfAborted();
          for (const name of ["ZCODE_APP_CLI_EXECUTABLE", "ZCODE_APP_CLI_ENTRY", "ZCODE_APP_CLI_VERSION"]) {
            const value = transport.env[name];
            if (value !== undefined) {
              inheritedEnvironment.set(name, process.env[name]);
              process.env[name] = value;
            }
          }
          child = spawn(transport.command, transport.args, {
            cwd: process.cwd(),
            env: { ...transport.env, ZCODE_CLI_TUI_IPC: "1" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            serialization: "advanced",
            windowsHide: true
          });
          child.stdout!.on("data", options.onDiagnostic);
          child.stderr!.on("data", options.onDiagnostic);
          exited = new Promise(resolve => {
            child!.once("error", error => { fail(error); resolve(1); });
            child!.once("close", (code, signal) => {
              const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
              peer?.close(new Error(`ZCode runtime exited with status ${exitCode}.`));
              fail(new Error(`ZCode runtime exited with status ${exitCode}.`));
              resolve(exitCode);
            });
          });
          const runtimeChild = child;
          peer = new RuntimeRpc(message => {
            runtimeChild.send(message as object, error => { if (error) peer?.close(error); });
          });
          peer.onFailure = fail;
          let mainSessionId: string | undefined;
          const sessionListeners = new Set<(event: unknown) => void>();
          const workflowListeners = new Set<(event: unknown) => void>();
          const connection = new Promise<TuiOptions>((resolve, reject) => {
            const onAbort = () => reject(failure ?? new Error("TUI startup cancelled."));
            lifecycle.signal.addEventListener("abort", onAbort, { once: true });
            peer!.onNotification = (name, value) => {
              if (name === "ready") {
                if (!isRecord(value) || !isRecord(value.fields) || !Array.isArray(value.methods)
                  || !value.methods.every(method => typeof method === "string" && !method.startsWith("$"))) {
                  reject(new Error("Invalid TUI runtime handshake."));
                  return;
                }
                lifecycle.signal.removeEventListener("abort", onAbort);
                backendReady = true;
                const remote = {
                  ...value.fields,
                  runtimeSignal: lifecycle.signal,
                  startupEditor: true
                } as unknown as TuiOptions;
                for (const method of value.methods as string[]) {
                  Object.defineProperty(remote, method, {
                    value: (...args: unknown[]) => peer!.call(method, ...args), enumerable: true
                  });
                }
                remote.getMainSessionId = () => mainSessionId;
                remote.subscribeSessionEvents = listener => {
                  sessionListeners.add(listener);
                  return () => { sessionListeners.delete(listener); };
                };
                remote.subscribeWorkflowEvents = listener => {
                  workflowListeners.add(listener);
                  return () => { workflowListeners.delete(listener); };
                };
                resolve(remote);
              } else if (name === "clipboard" && typeof value === "string"
                && value.length <= 1_400_000 && /^\x1b\]52;c;[A-Za-z0-9+/=]*\x07$/u.test(value)) {
                process.stdout.write(value);
              } else {
                const listeners = name === "session-event" ? sessionListeners
                  : name === "workflow-event" ? workflowListeners : undefined;
                for (const listener of listeners ?? []) listener(value);
              }
            };
          });
          child.on("message", message => {
            if (isRecord(message)) mainSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
            peer!.receive(message);
          });
          child.once("disconnect", () => peer?.close(new Error("ZCode runtime disconnected.")));
          const remote = await connection;
          const startup = await remote.loadStartupOptions?.();
          return { ...remote, ...startup, loadStartupOptions: undefined };
        };
        const [remote, loaded] = await Promise.all([backend(), import("./index.ts")]);
        implementation = loaded;
        return remote;
      }
    });
    if (readyOptions && implementation && !lifecycle.signal.aborted) {
      await implementation.runTui({ ...readyOptions, loadStartupOptions: undefined });
    }
    if (failure) throw failure;
    const exitCode = signalCode ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
    completedNormally = exitCode === 0;
    return exitCode;
  } finally {
    closing = true;
    await readyOptions?.startupScreen?.dispose();
    lifecycle.abort();
    let runtimeExitCode: number | undefined;
    if (child) {
      const runtimeChild = child;
      forceTermination = setTimeout(() => {
        runtimeChild.kill("SIGKILL");
        runtimeChild.stdout?.destroy();
        runtimeChild.stderr?.destroy();
        if (runtimeChild.connected) runtimeChild.disconnect();
      }, backendReady ? 7_000 : 500);
      if (backendReady && peer && runtimeChild.connected && !signalCode) {
        try { await peer.call("$finish"); } catch {}
      } else if (runtimeChild.exitCode === null && runtimeChild.signalCode === null) runtimeChild.kill("SIGTERM");
      if (exited) runtimeExitCode = await exited;
      runtimeChild.stdout?.destroy();
      runtimeChild.stderr?.destroy();
      if (runtimeChild.connected) runtimeChild.disconnect();
    }
    if (forceTermination) clearTimeout(forceTermination);
    peer?.close();
    for (const [name, value] of inheritedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (process.platform !== "win32") process.off("SIGHUP", onSighup);
    if (completedNormally && runtimeExitCode !== undefined && runtimeExitCode !== 0) {
      throw new Error(`ZCode runtime exited with status ${runtimeExitCode} during cleanup.`);
    }
  }
}
