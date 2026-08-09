import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const maximumOutputBytes = 16 * 1024 * 1024;
const forceTerminationDelayMilliseconds = 500;

export interface AppServerTransport {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface AppServerRequest {
  method: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  transport: AppServerTransport;
}

interface AppServerEnvelope {
  error?: {
    code?: number;
    data?: unknown;
    message?: string;
  };
  id?: unknown;
  result?: unknown;
}

export class AppServerRequestError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AppServerRequestError";
  }
}

function cancellationError(): Error {
  const error = new Error("App-server request cancelled.");
  error.name = "AbortError";
  return error;
}

async function readBounded(stream: Readable | null, onOverflow: () => void): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumOutputBytes) {
      onOverflow();
      throw new Error(`App-server output exceeded ${maximumOutputBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseEnvelope(stdout: string): AppServerEnvelope | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const envelope = parsed as AppServerEnvelope;
        if (envelope.id === 1) return envelope;
      }
    } catch {
      // Ignore non-protocol stdout and continue looking for the response envelope.
    }
  }
  return undefined;
}

export async function requestAppServer(request: AppServerRequest): Promise<unknown> {
  if (request.signal?.aborted) throw cancellationError();

  const child = spawn(request.transport.command, request.transport.args, {
    cwd: request.transport.cwd,
    env: request.transport.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let launchError: Error | undefined;
  let overflow = false;
  let forceTerminationTimer: NodeJS.Timeout | undefined;
  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", (error) => {
      launchError = error;
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
  });
  const terminateForOverflow = () => {
    overflow = true;
    child.kill("SIGKILL");
  };
  const onAbort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    forceTerminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, forceTerminationDelayMilliseconds);
    forceTerminationTimer.unref();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();

  child.stdin.on("error", () => {});
  child.stdin.end(`${JSON.stringify({ id: 1, method: request.method, params: request.params })}\n`);

  try {
    const [code, stdout, stderr] = await Promise.all([
      exited,
      readBounded(child.stdout, terminateForOverflow),
      readBounded(child.stderr, terminateForOverflow)
    ]);
    if (request.signal?.aborted) throw cancellationError();
    if (overflow) throw new Error(`App-server output exceeded ${maximumOutputBytes} bytes.`);
    if (launchError) throw launchError;

    const envelope = responseEnvelope(stdout);
    if (envelope?.error) {
      throw new AppServerRequestError(
        envelope.error.message?.trim() || "App-server request failed.",
        envelope.error.code,
        envelope.error.data
      );
    }
    if (code !== 0) {
      throw new Error(stderr.trim() || `App-server exited with status ${code}.`);
    }
    if (!envelope || !("result" in envelope)) {
      throw new Error(stderr.trim() || "App-server did not return a response envelope.");
    }
    return envelope.result;
  } finally {
    if (forceTerminationTimer) clearTimeout(forceTerminationTimer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
