export const TURN_TIMER_FRAME_DURATION_MS = 125;

// Unicode clock faces form a complete, same-style rotation with stable terminal width.
const turnTimerFrames = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"] as const;
const settledTurnTimerFrame = "🕛";
const reducedMotionValues = new Set(["1", "true", "yes", "on"]);

export function turnTimerAnimationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const reducedMotion = env.ZCODE_TUI_REDUCED_MOTION?.trim().toLowerCase() ?? "";
  return env.TERM?.trim().toLowerCase() !== "dumb" && !reducedMotionValues.has(reducedMotion);
}

export function turnTimerFrame(elapsedMilliseconds: number, animated = false): string {
  if (!animated) return settledTurnTimerFrame;
  const frame = Math.floor(Math.max(0, elapsedMilliseconds) / TURN_TIMER_FRAME_DURATION_MS);
  return turnTimerFrames[frame % turnTimerFrames.length] ?? turnTimerFrames[0];
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)}m ${seconds.toString().padStart(2, "0")}s`;
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export function turnStatusText(
  activity: string | undefined,
  elapsedMilliseconds: number,
  showElapsed = true,
  animateTimer = false
): string | undefined {
  if (!showElapsed) return activity;
  const elapsed = `[ ${turnTimerFrame(elapsedMilliseconds, animateTimer)} ${formatElapsed(elapsedMilliseconds)} ]`;
  return activity ? `${activity} ── ${elapsed}` : elapsed;
}
