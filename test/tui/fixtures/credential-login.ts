import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { recoverCredentialKey, withCredentialLoginPrompt } from "../../../src/managed-credentials.ts";

const filePath = join(process.env.HOME!, ".zcode", "v2", "credentials.json");
await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [{ role: "agent", content: "Login recovery scenario ready" }],
  submitPrompt: async (input, options) => {
    try {
      await withCredentialLoginPrompt(input, options, () => recoverCredentialKey(async () => {
        return readFile(join(dirname(filePath), "credential-secret"), "utf8").catch(() => {
          throw Object.assign(new Error("System credential storage is unavailable."), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
        });
      }, { filePath, env: {}, withLock: async (target, operation) => {
        await mkdir(dirname(target), { recursive: true });
        return operation();
      } }));
      return { response: "Login continued successfully" };
    } catch {
      return { response: "Login stopped without storing credentials" };
    }
  }
});
