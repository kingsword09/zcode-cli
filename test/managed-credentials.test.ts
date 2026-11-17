import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { credentialStorageError, recoverCredentialKey, setupManagedCredentialSecret, withCredentialLogin, withCredentialLoginPrompt } from "../src/managed-credentials.ts";

async function withWorkspace(operation: (directory: string, filePath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-managed-credentials-"));
  try {
    await operation(directory, join(directory, ".zcode", "v2", "credentials.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withLock<Result>(filePath: string, operation: () => Promise<Result>): Promise<Result> {
  await mkdir(dirname(filePath), { recursive: true });
  return operation();
}

function setup(filePath: string, env: NodeJS.ProcessEnv = {}) {
  return setupManagedCredentialSecret({ filePath, withLock, env });
}

test("creates a private persistent secret, uses the credential key lock and never rotates it", async () => {
  await withWorkspace(async (_directory, filePath) => {
    const result = await setupManagedCredentialSecret({ filePath, env: {}, withLock: async (target, operation) => {
      expect(target).toBe(`${filePath}.keyring`);
      return withLock(target, operation);
    } });
    const original = await readFile(result.filePath, "utf8");
    expect(result.created).toBe(true);
    expect(Buffer.from(original, "base64url").length).toBe(32);
    if (process.platform !== "win32") expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    expect(await setup(filePath)).toEqual({ filePath: result.filePath, created: false });
    expect(await readFile(result.filePath, "utf8")).toBe(original);
    expect(await readdir(dirname(filePath))).toEqual(["credential-secret"]);
  });
});

test("accepts an empty credentials object without changing it", async () => {
  await withWorkspace(async (_directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{}\n");
    expect((await setup(filePath)).created).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("{}\n");
  });
});

test.each(["enc:v2:os:existing", "enc:v2:env:existing", "enc:v1:existing", "plaintext"])("refuses to replace existing %s credentials", async credential => {
  await withWorkspace(async (_directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    const original = JSON.stringify({ token: credential });
    await writeFile(filePath, original);
    await expect(setup(filePath)).rejects.toThrow("original encryption key");
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(await readdir(dirname(filePath))).toEqual(["credentials.json"]);
  });
});

test.each(["invalid-json", "[]", "null", '"value"'])("refuses invalid credentials without changing them: %s", async original => {
  await withWorkspace(async (_directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, original);
    await expect(setup(filePath)).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(await readdir(dirname(filePath))).toEqual(["credentials.json"]);
  });
});

test("an OS source marker prevents switching even when credentials are empty", async () => {
  await withWorkspace(async (_directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(join(dirname(filePath), "credential-source"), "os\n");
    await expect(setup(filePath)).rejects.toThrow("OS-backed");
    expect(await readdir(dirname(filePath))).toEqual(["credential-source"]);
  });
});

test("an existing managed secret does not override OS-encrypted credentials without a marker", async () => {
  await withWorkspace(async (_directory, filePath) => {
    const result = await setup(filePath);
    const original = await readFile(result.filePath, "utf8");
    await writeFile(filePath, JSON.stringify({ token: "enc:v2:os:existing" }));
    await expect(setup(filePath)).rejects.toThrow("original encryption key");
    expect(await readFile(result.filePath, "utf8")).toBe(original);
  });
});

test("repeated setup preserves a secret used by existing managed credentials", async () => {
  await withWorkspace(async (_directory, filePath) => {
    const result = await setup(filePath);
    const original = await readFile(result.filePath, "utf8");
    await writeFile(filePath, JSON.stringify({ token: "enc:v2:env:existing" }));
    expect(await setup(filePath)).toEqual({ filePath: result.filePath, created: false });
    expect(await readFile(result.filePath, "utf8")).toBe(original);
  });
});

test.each([
  { ZCODE_CREDENTIAL_SECRET: "do-not-print-this-secret" },
  { ZCODE_CREDENTIAL_SECRET_FILE: "/private/secret" },
  { ZCODE_CREDENTIAL_SECRET: "do-not-print-this-secret", ZCODE_CREDENTIAL_SECRET_FILE: "/private/secret" }
])("refuses conflicting environment sources without printing them", async env => {
  await withWorkspace(async (_directory, filePath) => {
    await expect(setup(filePath, env)).rejects.toThrow("already configured");
    let prompts = 0;
    const error = unavailable();
    await expect(withCredentialLogin({ confirmCredentialStorage: async () => { prompts++; return true; } },
      () => recoverCredentialKey(async () => { throw error; }, { filePath, env, withLock }))).rejects.toBe(error);
    expect(prompts).toBe(0);
  });
});

test.each(["short", " ".repeat(4097)])("does not overwrite an invalid existing secret", async original => {
  await withWorkspace(async (_directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    const secretPath = join(dirname(filePath), "credential-secret");
    await writeFile(secretPath, original, { mode: 0o600 });
    await expect(setup(filePath)).rejects.toThrow("32–4096 bytes");
    expect(await readFile(secretPath, "utf8")).toBe(original);
  });
});

test.skipIf(process.platform === "win32")("refuses insecure permissions and symlinks without changing their targets", async () => {
  await withWorkspace(async (directory, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    const target = join(directory, "original-secret");
    const secretPath = join(dirname(filePath), "credential-secret");
    const original = "original-persistent-secret-at-least-32-bytes";
    await writeFile(secretPath, original, { mode: 0o600 });
    await chmod(secretPath, 0o644);
    await expect(setup(filePath)).rejects.toThrow("owner-only");
    await rm(secretPath);
    await writeFile(target, original, { mode: 0o600 });
    await symlink(target, secretPath);
    await expect(setup(filePath)).rejects.toThrow("regular");
    expect(await readFile(target, "utf8")).toBe(original);
  });
});

test("concurrent publication retains one secret without leaking temporary files", async () => {
  await withWorkspace(async (_directory, filePath) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => setup(filePath)));
    expect(results.filter(result => result.created).length).toBe(1);
    expect(await readdir(dirname(filePath))).toEqual(["credential-secret"]);
  });
});

test.each(["darwin", "linux", "win32"] as const)("secure-storage errors give actionable %s recovery without changing their identity", platform => {
  const cause = new Error("native failure");
  const error = Object.assign(new Error("System credential storage is unavailable. Old message"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE", cause });
  expect(credentialStorageError(error, platform)).toBe(error);
  expect(error.code).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
  expect(error.cause).toBe(cause);
  expect(error.message).toContain("/login or zcode login");
  expect(error.message).toContain("Existing credentials require their original key");
  if (platform === "darwin") expect(error.message).toContain("security unlock-keychain");
  if (platform === "linux") expect(error.message).toContain("user D-Bus");
  if (platform !== "darwin") expect(error.message).not.toContain("security unlock-keychain");
});

test("specific unlock and cancellation errors are not replaced by generic setup advice", () => {
  const error = new Error("Unlock cancelled; no credentials were changed.");
  expect(credentialStorageError(error)).toBe(error);
  expect(error.message).toBe("Unlock cancelled; no credentials were changed.");
});

const unavailable = () => Object.assign(new Error("System credential storage is unavailable."), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });

test("concurrent login writes ask once and retry only key acquisition", async () => {
  await withWorkspace(async (_directory, filePath) => {
    let prompts = 0, completed = 0;
    const acquire = async () => readFile(join(dirname(filePath), "credential-secret"), "utf8").catch(() => { throw unavailable(); });
    await withCredentialLoginPrompt("/login bigmodel-coding-plan", { confirmCredentialStorage: async () => { prompts++; return true; } }, async () => {
      completed++;
      const values = await Promise.all(Array.from({ length: 4 }, () => recoverCredentialKey(acquire, { filePath, env: {}, withLock })));
      expect(new Set(values).size).toBe(1);
    });
    expect({ prompts, completed }).toEqual({ prompts: 1, completed: 1 });
    expect(await readdir(dirname(filePath))).toEqual(["credential-secret"]);
  });
});

test.each(["decline", "abort", "background", "unlock-cancelled", "existing"])("%s does not create a replacement secret", async scenario => {
  await withWorkspace(async (directory, filePath) => {
    const abort = new AbortController();
    let prompts = 0;
    const error = unavailable();
    if (scenario === "unlock-cancelled") error.message = "Keychain unlock was cancelled; no credentials were changed.";
    if (scenario === "existing") {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify({ token: "enc:v2:os:existing" }));
    }
    const options = { abortSignal: abort.signal, confirmCredentialStorage: async () => {
      prompts++;
      if (scenario === "abort") abort.abort(new Error("Login cancelled"));
      return scenario !== "decline";
    } };
    await expect(withCredentialLoginPrompt(scenario === "background" ? "hello" : "/login zai-coding-plan-api-key fixture", options,
      () => recoverCredentialKey(async () => { throw error; }, { filePath, env: {}, withLock }))).rejects.toThrow();
    expect(prompts).toBe(["decline", "abort"].includes(scenario) ? 1 : 0);
    if (scenario === "existing") expect(await readdir(dirname(filePath))).toEqual(["credentials.json"]);
    else expect(await readdir(directory)).toEqual([]);
  });
});

test("state is checked again under the credential lock after confirmation", async () => {
  await withWorkspace(async (_directory, filePath) => {
    const original = JSON.stringify({ token: "enc:v2:os:concurrent-login" });
    await expect(withCredentialLogin({ confirmCredentialStorage: async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, original);
      return true;
    } }, () => recoverCredentialKey(async () => { throw unavailable(); }, { filePath, env: {}, withLock }))).rejects.toThrow("original encryption key");
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(await readdir(dirname(filePath))).toEqual(["credentials.json"]);
  });
});

test("working system storage never prompts or creates files", async () => {
  await withWorkspace(async (directory, filePath) => {
    let prompts = 0;
    expect(await withCredentialLogin({ confirmCredentialStorage: async () => { prompts++; return true; } },
      () => recoverCredentialKey(async () => "system-key", { filePath, env: {}, withLock }))).toBe("system-key");
    expect(prompts).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
