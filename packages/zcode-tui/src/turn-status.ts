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

export function turnStatusText(activity: string | undefined, elapsedMilliseconds: number): string {
  const elapsed = `[${formatElapsed(elapsedMilliseconds)}]`;
  return activity ? `${activity} · ${elapsed}` : elapsed;
}
