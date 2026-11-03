import { spawn } from "node:child_process";

const SLOTS_PER_MILLISECOND = 10_000n;

// Keep this sequence format aligned with the Herdr ZCode Plugin's hook reports.
export function agentReportSequence(
  nowMs = Date.now(),
  monotonicNs = process.hrtime.bigint()
) {
  const monotonicMicroseconds = (monotonicNs / 1000n) % SLOTS_PER_MILLISECOND;
  return BigInt(nowMs) * SLOTS_PER_MILLISECOND + monotonicMicroseconds;
}

export function reportInitialHerdrStatus(env = process.env, spawnProcess = spawn) {
  const binary = env.HERDR_BIN_PATH?.trim();
  const pane = env.HERDR_PANE_ID?.trim();
  if (env.HERDR_ENV !== "1" || !binary || !pane) return;

  const args = [
    "pane",
    "report-agent",
    pane,
    "--source",
    "herdr-zcode",
    "--agent",
    "zcode",
    "--state",
    "idle",
    "--seq",
    agentReportSequence().toString()
  ];

  try {
    const child = spawnProcess(binary, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Herdr status reporting is advisory; it must not prevent the TUI from starting.
  }
}

export async function runTuiWithHerdrStatus(run, env = process.env, spawnProcess = spawn) {
  reportInitialHerdrStatus(env, spawnProcess);
  return await run();
}
