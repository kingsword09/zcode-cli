import { mock } from "bun:test";
import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.HOME!;
const events = join(home, "events.jsonl");
let checks = 0;
mock.module("../../src/prompt-preflight.ts", () => ({
  missingCodingPlanKey: async () => {
    const check = ++checks;
    await appendFile(events, JSON.stringify({ check }) + "\n");
    if (check === 1) {
      while (!await access(join(home, "release")).then(() => true, () => false)) await Bun.sleep(10);
    }
    return check === 1 || check === 3 ? `PREFLIGHT_REJECTED_${check}` : undefined;
  }
}));

const { runTui } = await import("../../packages/zcode-tui/src/index.ts");
await runTui({
  initialModel: "zai/glm-5.3-flash",
  initialThoughtLevel: "low",
  workspaceDirectory: home,
  submitPrompt: async input => {
    await appendFile(events, JSON.stringify({ submitted: input }) + "\n");
    return { response: "OFFLINE_MOCK_RESPONSE" };
  }
});
