export function suppressTuiAiSdkWarnings(): void {
  const global = globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: unknown;
  };
  if (typeof global.AI_SDK_LOG_WARNINGS === "function") return;
  try {
    global.AI_SDK_LOG_WARNINGS = false;
  } catch {}
}
