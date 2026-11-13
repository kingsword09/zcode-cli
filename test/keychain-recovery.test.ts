import { expect, test } from "bun:test";
import {
  cacheCredentialKey,
  createKeychainRecovery,
  createRecoverableSystemKeyStore
} from "../src/runtime-keychain-recovery.ts";

const locked = () => new Error("Platform failure: User interaction is not allowed.");
const unavailable = () => Object.assign(new Error("Credential storage unavailable"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });

test("keychain unlock resumes the same pending operation and never replays completed work", async () => {
  let isLocked = true, reads = 0, unlocks = 0, completedWork = 0;
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; isLocked = false; } });
  const store = createRecoverableSystemKeyStore(async () => ({
    getSecret: async () => { reads++; if (isLocked) throw locked(); return [...Buffer.from("existing-key")]; },
    setPassword: async () => { throw new Error("Existing keys must not be replaced"); }
  }), unavailable, recover);
  completedWork++;
  expect(await store.get()).toBe("existing-key");
  expect({ reads, unlocks, completedWork }).toEqual({ reads: 2, unlocks: 1, completedWork: 1 });
});

test("concurrent credential readers share one unlock, including late failures", async () => {
  let unlocks = 0, isLocked = true;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; isLocked = false; } });
  const first = recover(async () => { if (isLocked) throw locked(); return "first"; });
  let lateReads = 0;
  const late = recover(async () => {
    if (++lateReads === 1) { await delayed; throw locked(); }
    return "late";
  });
  expect(await first).toBe("first");
  release();
  expect(await late).toBe("late");
  expect(unlocks).toBe(1);
});

test("simultaneous readers await one pending unlock", async () => {
  let unlocks = 0, isLocked = true;
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => {
    unlocks++;
    await new Promise(resolve => setTimeout(resolve, 10));
    isLocked = false;
  } });
  const read = () => recover(async () => { if (isLocked) throw locked(); return "key"; });
  expect(await Promise.all([read(), read(), read()])).toEqual(["key", "key", "key"]);
  expect(unlocks).toBe(1);
});

test("failed unlock is bounded and a later operation can try again", async () => {
  let unlocks = 0, isLocked = true;
  const cancelled = Object.assign(new Error("Unlock cancelled"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => {
    if (++unlocks === 1) throw cancelled;
    isLocked = false;
  } });
  const read = () => recover(async () => { if (isLocked) throw locked(); return "key"; });
  const first = await Promise.allSettled([read(), read()]);
  expect(first.every(result => result.status === "rejected" && result.reason === cancelled)).toBe(true);
  expect(unlocks).toBe(1);
  expect(await read()).toBe("key");
  expect(unlocks).toBe(2);
});

test("a late concurrent failure does not trigger another prompt after cancellation", async () => {
  let unlocks = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const cancelled = new Error("Unlock cancelled");
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; throw cancelled; } });
  const first = recover(async () => { throw locked(); }).catch(error => error);
  const late = recover(async () => { await delayed; throw locked(); });
  expect(await first).toBe(cancelled);
  release();
  await expect(late).rejects.toBe(cancelled);
  expect(unlocks).toBe(1);
});

test("an ACL failure after successful unlock does not loop", async () => {
  let unlocks = 0, reads = 0;
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; } });
  await expect(recover(async () => { reads++; throw locked(); })).rejects.toThrow("access is still denied");
  expect({ unlocks, reads }).toEqual({ unlocks: 1, reads: 2 });
});

test.each(["Keychain status: -25308", "errSecInteractionNotAllowed", "The keychain is locked"])("recognizes interaction failures: %s", async message => {
  let reads = 0, unlocks = 0;
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; } });
  expect(await recover(async () => { if (++reads === 1) throw new Error(message); return "key"; })).toBe("key");
  expect(unlocks).toBe(1);
});

test.each(["linux", "win32"] as const)("%s never invokes the macOS unlock flow", async platform => {
  let unlocks = 0;
  const recover = createKeychainRecovery({ platform, unlock: async () => { unlocks++; } });
  await expect(recover(async () => { throw locked(); })).rejects.toThrow("User interaction is not allowed");
  expect(unlocks).toBe(0);
});

test("unrelated storage errors do not prompt for a password", async () => {
  let unlocks = 0;
  const cause = new Error("Module could not be loaded");
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; } });
  const store = createRecoverableSystemKeyStore(async () => { throw cause; }, unavailable, recover);
  const error = await store.get().catch(error => error);
  expect(error.code).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
  expect(error.cause).toBe(cause);
  expect(unlocks).toBe(0);
});

test("missing keys stay missing and a locked write resumes with the same key", async () => {
  let unlocks = 0, writes = 0, isLocked = false;
  const saved: string[] = [];
  const recover = createKeychainRecovery({ platform: "darwin", unlock: async () => { unlocks++; isLocked = false; } });
  const store = createRecoverableSystemKeyStore(async () => ({
    getSecret: async () => null,
    setPassword: async value => { writes++; if (isLocked) throw locked(); saved.push(value); }
  }), unavailable, recover);
  expect(await store.get()).toBeNull();
  expect(unlocks).toBe(0);
  isLocked = true;
  await store.set("the-original-generated-key");
  expect(saved).toEqual(["the-original-generated-key"]);
  expect({ unlocks, writes }).toEqual({ unlocks: 1, writes: 2 });
});

test("a rejected key lookup is evicted so the same process can recover", async () => {
  const cache = new Map<string, Promise<string>>();
  const failed = cacheCredentialKey(cache, "credentials", Promise.reject(unavailable()));
  await expect(failed).rejects.toThrow("Credential storage unavailable");
  expect(cache.has("credentials")).toBe(false);
  const recovered = cacheCredentialKey(cache, "credentials", Promise.resolve("existing-key"));
  expect(await recovered).toBe("existing-key");
  expect(cache.get("credentials")).toBe(recovered);
});

test("failure cleanup cannot evict a newer lookup", async () => {
  const cache = new Map<string, Promise<string>>();
  let reject!: (error: Error) => void;
  const stale = cacheCredentialKey(cache, "credentials", new Promise<string>((_resolve, fail) => { reject = fail; }));
  const current = cacheCredentialKey(cache, "credentials", Promise.resolve("newer-key"));
  reject(unavailable());
  await expect(stale).rejects.toThrow();
  expect(cache.get("credentials")).toBe(current);
});
