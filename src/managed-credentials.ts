import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

type CredentialLock = <Result>(path: string, operation: () => Promise<Result>) => Promise<Result>;

interface CredentialSetupOptions {
  filePath: string;
  withLock: CredentialLock;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  abortSignal?: AbortSignal;
}

interface CredentialLoginOptions {
  abortSignal?: AbortSignal;
  confirmCredentialStorage?: (options: { signal?: AbortSignal }) => Promise<boolean>;
}

const loginContext = new AsyncLocalStorage<CredentialLoginOptions & { pending: Map<string, Promise<void>> }>();

export function credentialStorageError(error: Error, platform: NodeJS.Platform = process.platform): Error {
  if (!error.message.startsWith("System credential storage is unavailable.")) return error;
  const recovery = platform === "darwin"
    ? "On macOS, run security unlock-keychain in another terminal, then retry. If access is still denied, check the login keychain's access controls."
    : platform === "linux"
      ? "On Linux, unlock a Secret Service keyring and ensure this session has access to its user D-Bus. SSH, containers and servers may not have one."
      : "Unlock or restore access to the OS credential store, then retry.";
  error.message = `System credential storage is unavailable. ${recovery} For a first login, run /login or zcode login in an interactive terminal to choose local encrypted storage. Unattended environments can use ZCODE_CREDENTIAL_SECRET or a readable ZCODE_CREDENTIAL_SECRET_FILE containing 32–4096 bytes; do not set both. Existing credentials require their original key.`;
  return error;
}

async function inspectManagedCredentialSecret(options: CredentialSetupOptions): Promise<{ filePath: string; exists: boolean }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE) {
    throw new Error("A managed credential secret is already configured through the environment. Keep that source; do not configure both secret variables. No local secret was created.");
  }
  const filePath = resolve(options.filePath);
  const secretPath = join(dirname(filePath), "credential-secret");
  const inspect = async (target: string) => lstat(target).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const existingSecret = async (): Promise<boolean> => {
    const metadata = await inspect(secretPath);
    if (!metadata) return false;
    if (!metadata.isFile() || (platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("The existing credential-secret must be a regular, owner-only file. It was not changed.");
    }
    if (metadata.size < 32 || metadata.size > 4096) {
      throw new Error("The existing credential-secret must contain 32–4096 bytes. It was not changed.");
    }
    const secret = await readFile(secretPath, "utf8");
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes < 32 || bytes > 4096) {
      throw new Error("The existing credential-secret must contain 32–4096 bytes. It was not changed.");
    }
    return true;
  };
  if (await inspect(join(dirname(filePath), "credential-source"))) {
    throw new Error("Existing OS-backed credential storage cannot be switched to a new secret. Restore access to the original OS store, or use a separate ZCODE_DATA_BASE_DIR and log in again. No credentials or keys were changed.");
  }
  const credentials = await readFile(filePath, "utf8").catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  let hasCredentials = false;
  if (credentials !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentials);
    } catch {
      throw new Error("The existing credentials file is invalid. It was not changed; restore it before configuring credential storage.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The existing credentials file is invalid. It was not changed; restore it before configuring credential storage.");
    }
    hasCredentials = Object.keys(parsed).length !== 0;
    if (credentials.includes("enc:v2:os:")) {
      throw new Error("Existing credentials require their original encryption key. Restore the original secret or OS store, or use a separate ZCODE_DATA_BASE_DIR and log in again. No credentials or keys were changed.");
    }
  }
  if (await existingSecret()) return { filePath: secretPath, exists: true };
  if (hasCredentials) {
    throw new Error("Existing credentials require their original encryption key. Restore the original secret or OS store, or use a separate ZCODE_DATA_BASE_DIR and log in again. No credentials or keys were changed.");
  }
  return { filePath: secretPath, exists: false };
}

export async function setupManagedCredentialSecret(options: CredentialSetupOptions): Promise<{ filePath: string; created: boolean }> {
  return options.withLock(`${resolve(options.filePath)}.keyring`, async () => {
    options.abortSignal?.throwIfAborted();
    const state = await inspectManagedCredentialSecret(options);
    if (state.exists) return { filePath: state.filePath, created: false };
    const secretPath = state.filePath;
    const temporaryPath = `${secretPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await temporary.writeFile(randomBytes(32).toString("base64url"));
      } finally {
        await temporary.close();
      }
      options.abortSignal?.throwIfAborted();
      try {
        await link(temporaryPath, secretPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await inspectManagedCredentialSecret(options)).exists) throw error;
        return { filePath: secretPath, created: false };
      }
      return { filePath: secretPath, created: true };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
}

async function confirmInTerminal({ signal }: { signal?: AbortSignal }): Promise<boolean> {
  if (!process.stdin.isTTY || process.stdin.isRaw) return false;
  signal?.throwIfAborted();
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const closed = new AbortController();
  const onClose = () => closed.abort();
  prompt.once("close", onClose);
  try {
    const answer = await prompt.question("The system credential store is unavailable. Save your login encrypted on this device using a private local key file? Keep the key file to retain access to your login. [y/N] ", {
      signal: signal ? AbortSignal.any([signal, closed.signal]) : closed.signal
    });
    return /^(?:y|yes)$/iu.test(answer.trim());
  } catch (error) {
    signal?.throwIfAborted();
    if (closed.signal.aborted || (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return false;
    throw error;
  } finally {
    prompt.off("close", onClose);
    prompt.close();
  }
}

export function withCredentialLogin<Result>(options: CredentialLoginOptions | undefined, operation: () => Promise<Result>): Promise<Result> {
  const parent = loginContext.getStore();
  return loginContext.run({
    abortSignal: options?.abortSignal ?? parent?.abortSignal,
    confirmCredentialStorage: options?.confirmCredentialStorage ?? parent?.confirmCredentialStorage ?? confirmInTerminal,
    pending: parent?.pending ?? new Map()
  }, operation);
}

export function withCredentialLoginPrompt<Result>(input: unknown, options: CredentialLoginOptions | undefined, operation: () => Promise<Result>): Promise<Result> {
  return typeof input === "string" && /^\/login(?:\s|$)/iu.test(input)
    ? withCredentialLogin(options, operation)
    : operation();
}

export async function recoverCredentialKey<Result>(operation: () => Promise<Result>, options: CredentialSetupOptions): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    const context = loginContext.getStore();
    if (!context || !(error instanceof Error) || !("code" in error) || error.code !== "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"
      || !/^(?:System credential storage is unavailable\.|The keychain needs unlocking\.)/u.test(error.message)) throw error;
    context.abortSignal?.throwIfAborted();
    const filePath = resolve(options.filePath);
    let pending = context.pending.get(filePath);
    if (!pending) {
      pending = (async () => {
        const state = await inspectManagedCredentialSecret(options).catch(() => { throw error; });
        if (state.exists) return;
        if (!await context.confirmCredentialStorage?.({ signal: context.abortSignal })) throw error;
        context.abortSignal?.throwIfAborted();
        await setupManagedCredentialSecret({ ...options, abortSignal: context.abortSignal });
      })();
      context.pending.set(filePath, pending);
    }
    await pending;
    context.abortSignal?.throwIfAborted();
    return await operation();
  }
}
