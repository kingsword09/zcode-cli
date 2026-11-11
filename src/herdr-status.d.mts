export function agentReportSequence(nowMs?: number, monotonicNs?: bigint): bigint;
export function reportInitialHerdrStatus(
  env?: NodeJS.ProcessEnv,
  spawnProcess?: typeof import("node:child_process").spawn
): void;
export function runTuiWithHerdrStatus(
  run: () => Promise<number>,
  env?: NodeJS.ProcessEnv,
  spawnProcess?: typeof import("node:child_process").spawn
): Promise<number>;
