import { isRecord } from "./types.ts";

const protocol = "zcode-tui/1";
const maximumPendingCalls = 2_048;
const maximumValueNodes = 200_000;

type Handler = (...args: unknown[]) => unknown;
type WireValue = unknown;

interface Scope {
  cleanup: Array<() => void>;
  nodes: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  scope: Scope;
}

export class RuntimeRpc {
  private sequence = 0;
  private readonly handlers = new Map<string, Handler>();
  private readonly callbacks = new Map<string, Handler>();
  private readonly pending = new Map<number, PendingCall>();
  private readonly incoming = new Set<Scope>();
  private readonly signals = new Map<number, AbortController>();
  private failure?: Error;
  onNotification?: (name: string, value: unknown) => void;
  onFailure?: (error: Error) => void;

  constructor(private readonly send: (message: unknown) => void) {}

  register(name: string, handler: Handler): void {
    if (name.startsWith("@") || this.handlers.has(name)) throw new Error("Invalid runtime RPC method.");
    this.handlers.set(name, handler);
  }

  call(name: string, ...args: unknown[]): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= maximumPendingCalls) return Promise.reject(new Error("Too many pending runtime requests."));
    const id = ++this.sequence;
    const scope: Scope = { cleanup: [], nodes: 0 };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, scope });
      try {
        this.write({ type: "call", id, name, value: this.encode(args, scope, true) });
      } catch (error) {
        this.pending.delete(id);
        this.release(scope);
        reject(error);
      }
    });
  }

  notify(name: string, value: unknown): void {
    if (this.failure) return;
    this.write({ type: "notify", name, value: this.encode(value, { cleanup: [], nodes: 0 }, false) });
  }

  receive(message: unknown): void {
    if (this.failure || !isRecord(message) || message.protocol !== protocol) return;
    try {
      if (message.type === "abort" && typeof message.id === "number") {
        this.signals.get(message.id)?.abort(this.decode(message.reason, { cleanup: [], nodes: 0 }));
      } else if (message.type === "notify" && typeof message.name === "string") {
        this.onNotification?.(message.name, this.decode(message.value, { cleanup: [], nodes: 0 }));
      } else if (message.type === "result" && typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        try {
          const value = this.decode(message.value, pending.scope);
          if (message.failed) pending.reject(value instanceof Error ? value : new Error("Runtime request failed."));
          else pending.resolve(value);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error("Invalid runtime response."));
          throw error;
        } finally {
          this.release(pending.scope);
        }
      } else if (message.type === "call" && typeof message.id === "number" && typeof message.name === "string") {
        void this.dispatch(message.id, message.name, message.value);
      } else {
        throw new Error("Invalid runtime RPC message.");
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("Invalid runtime RPC message."));
    }
  }

  close(error = new Error("Runtime connection closed.")): void {
    if (this.failure) return;
    this.failure = error;
    for (const controller of this.signals.values()) controller.abort(error);
    for (const pending of this.pending.values()) {
      this.release(pending.scope);
      pending.reject(error);
    }
    for (const scope of this.incoming) this.release(scope);
    this.pending.clear();
    this.incoming.clear();
    this.signals.clear();
    this.callbacks.clear();
    this.handlers.clear();
    this.onFailure?.(error);
  }

  private write(message: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    this.send({ protocol, ...message });
  }

  private async dispatch(id: number, name: string, value: WireValue): Promise<void> {
    const scope: Scope = { cleanup: [], nodes: 0 };
    this.incoming.add(scope);
    try {
      const handler = name.startsWith("@") ? this.callbacks.get(name) : this.handlers.get(name);
      if (!handler) throw new Error("Runtime method is unavailable.");
      const args = this.decode(value, scope);
      if (!Array.isArray(args)) throw new Error("Invalid runtime request arguments.");
      const result = await handler(...args);
      if (!this.failure) this.write({ type: "result", id, value: this.encode(result, scope, false) });
    } catch (error) {
      if (!this.failure) {
        try {
          this.write({ type: "result", id, failed: true, value: this.encode(
            error instanceof Error ? error : new Error(String(error)), { cleanup: [], nodes: 0 }, false
          ) });
        } catch (failure) {
          this.close(failure instanceof Error ? failure : new Error("Runtime response failed."));
        }
      }
    } finally {
      this.incoming.delete(scope);
      this.release(scope);
    }
  }

  private release(scope: Scope): void {
    for (const cleanup of scope.cleanup.splice(0)) cleanup();
  }

  private checkValue(scope: Scope, depth: number): void {
    if (++scope.nodes > maximumValueNodes || depth > 64) throw new Error("Runtime value is too large or deeply nested.");
  }

  private encode(value: unknown, scope: Scope, references: boolean, depth = 0): WireValue {
    this.checkValue(scope, depth);
    if (typeof value === "function") {
      if (!references) throw new Error("Runtime results must not contain functions.");
      const name = `@${++this.sequence}`;
      this.callbacks.set(name, value as Handler);
      scope.cleanup.push(() => this.callbacks.delete(name));
      return { kind: "callback", name };
    }
    if (value instanceof AbortSignal) {
      if (!references) throw new Error("Runtime results must not contain abort signals.");
      const id = ++this.sequence;
      const reason = () => this.encode(value.reason, { cleanup: [], nodes: 0 }, false);
      const onAbort = () => {
        if (!this.failure) this.write({ type: "abort", id, reason: reason() });
      };
      value.addEventListener("abort", onAbort, { once: true });
      scope.cleanup.push(() => value.removeEventListener("abort", onAbort));
      return { kind: "signal", id, aborted: value.aborted, reason: value.aborted ? reason() : undefined };
    }
    if (value instanceof Error) {
      const fields = Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry !== "function"));
      return { kind: "error", name: value.name, message: value.message, fields: this.encode(fields, scope, false, depth + 1) };
    }
    if (Array.isArray(value)) return { kind: "array", value: value.map(entry => this.encode(entry, scope, references, depth + 1)) };
    if (value instanceof Set) return { kind: "set", value: [...value].map(entry => this.encode(entry, scope, references, depth + 1)) };
    if (value instanceof Map) return {
      kind: "map", value: [...value].map(([key, entry]) => [this.encode(key, scope, references, depth + 1), this.encode(entry, scope, references, depth + 1)])
    };
    if (value instanceof Date || value instanceof Uint8Array || value instanceof ArrayBuffer) return { kind: "native", value };
    if (isRecord(value)) return {
      kind: "object", value: Object.entries(value).map(([key, entry]) => [key, this.encode(entry, scope, references, depth + 1)])
    };
    if (value === null || value === undefined || ["string", "number", "boolean", "bigint"].includes(typeof value)) {
      return { kind: "scalar", value };
    }
    throw new Error("Unsupported runtime value.");
  }

  private decode(value: WireValue, scope: Scope, depth = 0): unknown {
    this.checkValue(scope, depth);
    if (!isRecord(value)) throw new Error("Invalid runtime value.");
    if (value.kind === "scalar" || value.kind === "native") return value.value;
    if (value.kind === "callback" && typeof value.name === "string") {
      const name = value.name;
      return (...args: unknown[]) => this.call(name, ...args);
    }
    if (value.kind === "signal" && typeof value.id === "number") {
      const id = value.id;
      const controller = new AbortController();
      this.signals.set(id, controller);
      scope.cleanup.push(() => this.signals.delete(id));
      if (value.aborted) controller.abort(this.decode(value.reason, scope, depth + 1));
      return controller.signal;
    }
    if (value.kind === "error" && typeof value.message === "string") {
      const error = new Error(value.message);
      error.name = typeof value.name === "string" ? value.name : "Error";
      Object.assign(error, this.decode(value.fields, scope, depth + 1));
      return error;
    }
    if (!Array.isArray(value.value)) throw new Error("Invalid runtime collection.");
    if (value.kind === "array" || value.kind === "set") {
      const entries = value.value.map(entry => this.decode(entry, scope, depth + 1));
      return value.kind === "array" ? entries : new Set(entries);
    }
    if (value.kind === "object" || value.kind === "map") {
      const entries = value.value.map((entry: unknown) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid runtime entry.");
        const key = value.kind === "object" ? entry[0] : this.decode(entry[0], scope, depth + 1);
        if (value.kind === "object" && typeof key !== "string") throw new Error("Invalid runtime object key.");
        return [key, this.decode(entry[1], scope, depth + 1)] as const;
      });
      return value.kind === "object" ? Object.fromEntries(entries) : new Map(entries);
    }
    throw new Error("Invalid runtime value kind.");
  }
}
