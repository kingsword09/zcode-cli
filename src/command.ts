import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function readText(stream: Readable | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function captureCommand(command: string, args: string[]): Promise<CommandResult> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let launchError = "";
  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", (error) => {
      launchError = error.message;
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
  });
  const [code, stdout, stderr] = await Promise.all([
    exited,
    readText(child.stdout),
    readText(child.stderr)
  ]);
  return { code, stdout, stderr: stderr || launchError };
}
