import { suppressTuiAiSdkWarnings } from "./ai-sdk-warnings.ts";
import { loadTuiStartupOptions } from "./startup.ts";
import type { TuiOptions } from "./types.ts";

suppressTuiAiSdkWarnings();

export async function runTui(options: TuiOptions): Promise<void> {
  if (process.env.ZCODE_CLI_TUI_IPC === "1" && process.send) {
    await (await import("./runtime-host.ts")).runRuntimeTuiHost(options);
    return;
  }
  const loadStartupOptions = options.loadStartupOptions;
  if (!loadStartupOptions) {
    await (await import("./index.ts")).runTui(options);
    return;
  }

  let implementation: typeof import("./index.ts") | undefined;
  const readyOptions = await loadTuiStartupOptions({
    ...options,
    loadStartupOptions: async () => {
      const [startup, loaded] = await Promise.all([
        loadStartupOptions(),
        import("./index.ts")
      ]);
      implementation = loaded;
      return startup;
    }
  });
  if (readyOptions && implementation) {
    await implementation.runTui({ ...readyOptions, loadStartupOptions: undefined });
  }
}
