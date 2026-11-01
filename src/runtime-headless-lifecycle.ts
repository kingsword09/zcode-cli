import type { Writable } from "node:stream";

function flushOutput(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write("", (error) => error ? reject(error) : resolve());
  });
}

export async function withHeadlessPromptLifecycle<Result>(
  output: { stdout: Writable; stderr: Writable },
  run: () => Promise<Result>
): Promise<Result> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await run();
  } finally {
    try {
      await Promise.all([flushOutput(output.stdout), flushOutput(output.stderr)]);
    } finally {
      clearInterval(keepAlive);
    }
  }
}
