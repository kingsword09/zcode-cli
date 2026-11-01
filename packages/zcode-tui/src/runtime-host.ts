import { RuntimeRpc } from "./runtime-rpc.ts";
import { createRuntimePluginReferenceLister } from "./plugin-references.ts";
import type { TuiOptions } from "./types.ts";

const localFields = new Set(["stdin", "stdout", "stderr", "runtimeSignal", "initialInputDraft", "startupEditor", "startupScreen"]);
const specialMethods = new Set(["getMainSessionId", "subscribeSessionEvents", "subscribeWorkflowEvents"]);

export async function runRuntimeTuiHost(options: TuiOptions): Promise<void> {
  if (!process.send) throw new Error("The TUI runtime host requires a local IPC connection.");
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const subscriptions: Array<() => void> = [];
  const peer = new RuntimeRpc(message => {
    process.send!({ ...message as object, sessionId: options.getMainSessionId?.() }, error => {
      if (error) peer.close(error);
    });
  });
  const onMessage = (message: unknown) => peer.receive(message);
  const onDisconnect = () => peer.close();
  peer.onFailure = finish;
  process.on("message", onMessage);
  process.once("disconnect", onDisconnect);
  const stdout = options.stdout;
  const originalWrite = stdout?.write;
  if (stdout && originalWrite) {
    stdout.write = function (...args: unknown[]): boolean {
      const text = typeof args[0] === "string" ? args[0] : undefined;
      if (text && text.length <= 1_400_000 && /^\x1b\]52;c;[A-Za-z0-9+/=]*\x07$/u.test(text)) {
        peer.notify("clipboard", text);
        const callback = args.findLast(value => typeof value === "function");
        if (typeof callback === "function") queueMicrotask(() => callback());
        return true;
      }
      return Reflect.apply(originalWrite, stdout, args) as boolean;
    } as typeof stdout.write;
  }
  try {
    const fields: Record<string, unknown> = {};
    const methods: string[] = [];
    const runtimeOptions: TuiOptions = {
      ...options,
      listPluginReferences: options.listPluginReferences
        ?? createRuntimePluginReferenceLister(options.workspaceDirectory ?? process.cwd())
    };
    for (const [name, value] of Object.entries(runtimeOptions)) {
      if (localFields.has(name) || specialMethods.has(name)) continue;
      if (typeof value === "function") {
        methods.push(name);
        peer.register(name, (...args) => value.apply(options, args));
      } else fields[name] = value;
    }
    peer.register("$finish", () => { setImmediate(finish); });
    for (const [name, subscribe] of [
      ["session-event", options.subscribeSessionEvents],
      ["workflow-event", options.subscribeWorkflowEvents]
    ] as const) {
      const unsubscribe = subscribe?.(event => {
        try { peer.notify(name, event); }
        catch (error) { peer.close(error instanceof Error ? error : new Error("Runtime event delivery failed.")); }
      });
      if (unsubscribe) subscriptions.push(unsubscribe);
    }
    peer.notify("ready", { fields, methods });
    await done;
  } finally {
    if (stdout && originalWrite) stdout.write = originalWrite;
    for (const unsubscribe of subscriptions) unsubscribe();
    peer.close();
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
    if (process.connected) process.disconnect?.();
  }
}
