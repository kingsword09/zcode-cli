import { readCliSettings } from "../../../src/model-access.ts";

/**
 * `ui.quotaStatusline` (default **off**): when enabled, the compact statusline
 * gains a `quota <percent>%` segment showing the lowest remaining balance of
 * the signed-in account's plan slots. Configured in `setting.json` only — the
 * statusline stays minimal unless the user opts in.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveQuotaStatusline(config: unknown): boolean {
  return record(record(config)?.ui)?.quotaStatusline === true;
}

export async function readQuotaStatusline(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    return resolveQuotaStatusline(await readCliSettings(env));
  } catch {
    return false; // unreadable settings must never break the statusline
  }
}
