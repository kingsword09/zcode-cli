import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const mode = process.env.ZCODE_TEST_RESUME_TARGET;
await runTui({
  initialModel: "fixture/model",
  readSessionUsage: async () => ({ sessionId: "id-only", totalTokens: 10 }),
  readRuntimeProjection: async () => { throw new Error("Projection unavailable"); },
  ...(mode === "unsupported" ? {} : {
    readSessionResumeTarget: async () => {
      if (mode === "saved") return "saved-session";
      if (mode === "unreadable") throw new Error("Store unreadable");
      if (mode === "timeout") return new Promise<string | undefined>(() => {});
      return undefined;
    }
  }),
  submitPrompt: async () => { throw new Error("Session not found: missing"); },
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
});
