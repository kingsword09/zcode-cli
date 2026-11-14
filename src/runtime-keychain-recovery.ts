import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

type Recovery = <Result>(operation: () => Promise<Result>) => Promise<Result>;

interface KeyringEntry {
  getSecret(): Promise<number[] | null>;
  setPassword(value: string): Promise<void>;
}

function recoveryError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
}

function interactionRequired(error: unknown): boolean {
  return error instanceof Error
    && /user interaction is not allowed|interaction (?:is )?not allowed|keychain (?:is )?locked|errSecInteractionNotAllowed|(?:^|\D)-25308(?:\D|$)/iu.test(error.message);
}

export async function unlockKeychainInTerminal(): Promise<void> {
  if (process.stdin.isRaw) {
    throw recoveryError("The keychain needs unlocking. Unlock it with security unlock-keychain in another terminal, then retry the operation in this session.");
  }
  let terminal: number;
  try {
    terminal = openSync("/dev/tty", "r+");
  } catch (cause) {
    throw recoveryError("The keychain needs unlocking, but no controlling terminal is available. Run security unlock-keychain in an interactive SSH session or configure a managed credential secret.", cause);
  }
  const wasFlowing = process.stdin.isTTY && process.stdin.readableFlowing === true;
  try {
    if (!isatty(terminal)) throw recoveryError("Keychain unlock requires a controlling terminal.");
    if (wasFlowing) process.stdin.pause();
    writeSync(terminal, "\nThe macOS keychain needs unlocking to continue. Enter its password below (Ctrl-C to cancel).\n");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["unlock-keychain"], { stdio: [terminal, terminal, terminal] });
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const handlers = signals.map(signal => {
        const hadListeners = process.listenerCount(signal) > 0;
        const forward = () => {
          child.kill(signal);
          if (!hadListeners) {
            process.off(signal, forward);
            process.kill(process.pid, signal);
          }
        };
        process.prependListener(signal, forward);
        return { signal, forward };
      });
      const cleanup = () => { for (const { signal, forward } of handlers) process.off(signal, forward); };
      child.once("error", cause => {
        cleanup();
        reject(recoveryError("Could not start the system keychain unlock tool.", cause));
      });
      child.once("close", (code, signal) => {
        cleanup();
        if (code === 0) resolve();
        else reject(recoveryError(signal
          ? `Keychain unlock was cancelled (${signal}); no credentials were changed.`
          : "Keychain unlock failed; no credentials were changed. Retry the operation to try again."));
      });
    });
    writeSync(terminal, "Keychain unlocked; continuing the pending credential operation.\n");
  } finally {
    closeSync(terminal);
    if (wasFlowing) process.stdin.resume();
  }
}

export function createKeychainRecovery(options: {
  platform?: NodeJS.Platform;
  unlock?: () => Promise<void>;
} = {}): Recovery {
  const platform = options.platform ?? process.platform;
  const unlock = options.unlock ?? unlockKeychainInTerminal;
  let pending: Promise<void> | undefined;
  let generation = 0;
  let lastFailure: unknown;
  return async operation => {
    const started = generation;
    try {
      return await operation();
    } catch (error) {
      if (platform !== "darwin" || !interactionRequired(error)) throw error;
      if (started === generation) {
        if (!pending) {
          pending = Promise.resolve().then(unlock).then(() => {
            lastFailure = undefined;
          }, cause => {
            lastFailure = cause;
            throw cause;
          }).finally(() => {
            generation++;
            pending = undefined;
          });
        }
        await pending;
      } else if (lastFailure !== undefined) {
        throw lastFailure;
      }
      try {
        return await operation();
      } catch (cause) {
        if (interactionRequired(cause)) {
          throw recoveryError("Keychain unlock completed, but credential access is still denied. Check the keychain item's access controls in a local macOS session.", cause);
        }
        throw cause;
      }
    }
  };
}

const recoverKeychain = createKeychainRecovery();

export function createRecoverableSystemKeyStore(
  entry: () => Promise<KeyringEntry>,
  unavailable: () => Error,
  recover: Recovery = recoverKeychain
): { get(): Promise<string | null>; set(value: string): Promise<void> } {
  const attempt = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try {
      return await recover(operation);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE") throw cause;
      const error = unavailable();
      error.cause = cause;
      throw error;
    }
  };
  return {
    get: () => attempt(async () => {
      const secret = await (await entry()).getSecret();
      return secret === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(secret));
    }),
    set: value => attempt(async () => { await (await entry()).setPassword(value); })
  };
}

export function cacheCredentialKey<Result>(cache: Map<string, Promise<Result>>, path: string, pending: Promise<Result>): Promise<Result> {
  const tracked = pending.catch(error => {
    if (cache.get(path) === tracked) cache.delete(path);
    throw error;
  });
  cache.set(path, tracked);
  return tracked;
}
