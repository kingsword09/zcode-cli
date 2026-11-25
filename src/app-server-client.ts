import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const maximumOutputBytes = 16 * 1024 * 1024;
const forceTerminationDelayMilliseconds = 500;
const cooperativeCancellationDelayMilliseconds = 3_000;

export interface AppServerTransport {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface AppServerRequest {
  cancellation?: { method: string; params: Record<string, unknown> };
  method: string;
  onStderr?: (stderr: string) => void;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
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

export class AppServerProcessError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
    this.name = "AppServerProcessError";
  }
}

export class AppServerCancellationError extends Error {
  constructor(public readonly exitCode: number) {
    super("App-server request cancelled.");
    this.name = "AbortError";
  }
}

export class AppServerTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`App-server request timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = (osConstants.signals as Record<string, number>)[signal];
  return typeof number === "number" ? 128 + number : 1;
}

function abortSignalName(signal?: AbortSignal): NodeJS.Signals | undefined {
  const reason = signal?.reason;
  return reason === "SIGINT" || reason === "SIGTERM" || reason === "SIGHUP" ? reason : undefined;
}

function cancellationError(signal?: AbortSignal): AppServerCancellationError {
  const signalName = abortSignalName(signal);
  if (signalName) return new AppServerCancellationError(signalExitCode(signalName));
  return new AppServerCancellationError(130);
}

function terminationSignal(signal?: AbortSignal): NodeJS.Signals {
  return abortSignalName(signal) ?? "SIGTERM";
}

/*
 * Keep the process result available to launcher-owned commands. A plain Error
 * would collapse every app-server failure to exit status 1.
 */
function processError(message: string, code: number): AppServerProcessError {
  return new AppServerProcessError(message, code);
}

async function readBounded(stream: Readable | null, onOverflow: () => void, onChunk?: (chunk: Buffer) => void): Promise<string> {
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
    onChunk?.(buffer);
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
  if (request.signal?.aborted) throw cancellationError(request.signal);
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs)
    || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647)) {
    throw new Error("App-server timeoutMs must be an integer between 1 and 2147483647.");
  }

  const child = spawn(request.transport.command, request.transport.args, {
    cwd: request.transport.cwd,
    env: request.transport.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let launchError: Error | undefined;
  let overflow = false;
  let forceTerminationTimer: NodeJS.Timeout | undefined;
  let requestTimeoutTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let cancelling = false;
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
    child.once("close", (code, signal) => finish(code ?? signalExitCode(signal)));
  });
  const terminateForOverflow = () => {
    overflow = true;
    child.kill("SIGKILL");
  };
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(terminationSignal(request.signal));
    forceTerminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, forceTerminationDelayMilliseconds);
    forceTerminationTimer.unref();
  };
  const onAbort = () => {
    if (cancelling || child.exitCode !== null || child.signalCode !== null) return;
    cancelling = true;
    if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
    if (request.cancellation && !child.stdin.writableEnded && !child.stdin.destroyed) {
      // Serial app-server handlers may not read the cancellation until the original
      // request finishes. EOF also triggers client-disconnect cancellation so the
      // runtime can abort downloads and unwind its storage-lock finally blocks.
      child.stdin.end(`${JSON.stringify({ id: 2, ...request.cancellation })}\n`);
      forceTerminationTimer = setTimeout(terminate, cooperativeCancellationDelayMilliseconds);
      forceTerminationTimer.unref();
    } else terminate();
  };

  child.stdin.on("error", () => {});
  // 3.14 treats stdin EOF as client disconnection and cancels outstanding work.
  // Send one NDJSON request, but keep the transport alive until its response.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const stdoutPromise = readBounded(child.stdout, terminateForOverflow, chunk => {
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (responseEnvelope(line) && !child.stdin.writableEnded) child.stdin.end();
    }
  });
  child.stdin.write(`${JSON.stringify({ id: 1, method: request.method, params: request.params })}\n`);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  else if (request.timeoutMs !== undefined) {
    requestTimeoutTimer = setTimeout(() => { timedOut = true; onAbort(); }, request.timeoutMs);
    requestTimeoutTimer.unref();
  }

  try {
    const [code, stdout, stderr] = await Promise.all([
      exited,
      stdoutPromise,
      readBounded(child.stderr, terminateForOverflow)
    ]);
    if (timedOut) throw new AppServerTimeoutError(request.timeoutMs!);
    if (request.signal?.aborted) throw cancellationError(request.signal);
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
      throw processError(stderr.trim() || `App-server exited with status ${code}.`, code);
    }
    if (!envelope || !("result" in envelope)) {
      throw new Error(stderr.trim() || "App-server did not return a response envelope.");
    }
    if (stderr) request.onStderr?.(stderr);
    return envelope.result;
  } finally {
    if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
    if (forceTerminationTimer) clearTimeout(forceTerminationTimer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
