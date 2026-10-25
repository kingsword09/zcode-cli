import { runTui } from "../../../packages/zcode-tui/src/index.ts";

if (process.argv[2] === "parent") {
  // A fresh process reads the same PTY after the TUI exits, like the parent shell.
  const input = await new Promise<string>((resolve) => {
    let received = "";
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    const onData = (data: string) => {
      received += data;
      const end = received.indexOf("\r");
      if (end === -1) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      process.stdin.setRawMode(false);
      resolve(received.slice(0, end));
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
    console.log("EXIT_PARENT_READY");
  });
  console.log(`EXIT_PARENT_INPUT ${JSON.stringify(input)}`);
  console.log(`EXIT_TUI_STATUS ${process.argv[3]}`);
} else {
  console.log(`EXIT_TUI_PID ${process.pid}`);
  await runTui({
    initialModel: "scenario/model",
    theme: "dark",
    workspaceDirectory: process.cwd(),
    loadStartupOptions: process.argv[2] === "startup"
      ? () => new Promise(() => {})
      : undefined,
    loadSessionTranscript: async () => [{ role: "agent", content: "EXIT_READY" }],
    submitPrompt: async () => ({ response: "Unexpected submission" })
  });
  console.log(`EXIT_RAW_MODE ${Boolean(process.stdin.isRaw)}`);
}
