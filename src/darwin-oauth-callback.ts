import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { captureCommand, type CommandResult } from "./command.ts";

const launchServicesRegister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const managedBundlePrefix = "dev.zcode.cli.oauth-callback.";
const managedAppPrefix = "ZCode CLI OAuth Callback ";
const defaultTimeoutMs = 5 * 60_000;

const currentHandlerScript = String.raw`
ObjC.import("AppKit");
function run(argv) {
  const url = $.NSURL.URLWithString(argv[0] + "://");
  const appUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
  if (!appUrl || appUrl.isNil()) return "";
  const bundle = $.NSBundle.bundleWithURL(appUrl);
  return !bundle || bundle.isNil() ? "" : ObjC.unwrap(bundle.bundleIdentifier);
}
`;

const setHandlerScript = String.raw`
ObjC.import("CoreServices");
function run(argv) {
  return String(Number($.LSSetDefaultHandlerForURLScheme($(argv[0]), $(argv[1]))));
}
`;

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

interface RecoveryRecord {
  appPath: string;
  bundleId: string;
  pid: number;
  previousHandler: string;
  scheme: string;
}

export interface DarwinUrlCallbackReceiver {
  dispose(): Promise<void>;
  waitForCallback(signal?: AbortSignal, timeoutMs?: number): Promise<string>;
}

export interface DarwinUrlCallbackOptions {
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  scheme: string;
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await captureCommand(command, args);
}

async function checkedRun(
  runner: CommandRunner,
  command: string,
  args: string[]
): Promise<string> {
  const result = await runner(command, args);
  if (result.code !== 0) {
    const diagnostic = result.stderr.trim() || result.stdout.trim() || `status ${result.code}`;
    throw new Error(`${basename(command)} failed: ${diagnostic}`);
  }
  return result.stdout.trim();
}

async function currentDefaultHandler(runner: CommandRunner, scheme: string): Promise<string> {
  return checkedRun(runner, "/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    currentHandlerScript,
    scheme
  ]);
}

async function setDefaultHandler(
  runner: CommandRunner,
  scheme: string,
  bundleId: string
): Promise<void> {
  const status = await checkedRun(runner, "/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    setHandlerScript,
    scheme,
    bundleId
  ]);
  if (status !== "0") throw new Error(`Unable to register the ${scheme} callback handler (status ${status}).`);
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function callbackAppleScript(
  callbackPath: string,
  scheme: string,
  previousHandler: string
): string[] {
  const restoreCommand = [
    "/usr/bin/osascript",
    "-l",
    "JavaScript",
    "-e",
    setHandlerScript,
    scheme,
    previousHandler || "none"
  ].map(shellQuote).join(" ");
  return [
    "on open location theURL",
    `set outputFile to POSIX file ${appleScriptString(callbackPath)}`,
    "try",
    "set fileHandle to open for access outputFile with write permission",
    "set eof fileHandle to 0",
    "write theURL to fileHandle as «class utf8»",
    "close access fileHandle",
    "on error",
    "try",
    "close access outputFile",
    "end try",
    "end try",
    "try",
    `do shell script ${appleScriptString(restoreCommand)}`,
    "end try",
    "quit",
    "end open location"
  ];
}

function recoveryPath(home: string): string {
  return join(home, ".zcode", "cli", "oauth-handler-recovery.json");
}

function applicationsDirectory(home: string): string {
  return join(home, "Applications");
}

function isManagedRecovery(record: unknown, home: string): record is RecoveryRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as Partial<RecoveryRecord>;
  if (typeof value.appPath !== "string"
    || typeof value.bundleId !== "string"
    || typeof value.pid !== "number"
    || typeof value.previousHandler !== "string"
    || typeof value.scheme !== "string") return false;
  const appRoot = `${resolve(applicationsDirectory(home))}${sep}`;
  return resolve(value.appPath).startsWith(appRoot)
    && basename(value.appPath).startsWith(managedAppPrefix)
    && value.bundleId.startsWith(managedBundlePrefix);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRecovery(home: string): Promise<RecoveryRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recoveryPath(home), "utf8"));
    return isManagedRecovery(parsed, home) ? parsed : null;
  } catch {
    return null;
  }
}

async function unregisterApp(runner: CommandRunner, appPath: string): Promise<void> {
  await runner(launchServicesRegister, ["-u", appPath]).catch(() => ({
    code: 1,
    stderr: "",
    stdout: ""
  }));
}

export async function recoverStaleDarwinOAuthHandler(
  options: DarwinUrlCallbackOptions
): Promise<void> {
  const runner = options.runCommand ?? runCommand;
  const home = options.env?.HOME || homedir();
  const path = recoveryPath(home);
  const record = await readRecovery(home);
  if (!record) {
    await rm(path, { force: true });
    return;
  }
  if (record.pid !== process.pid && processIsAlive(record.pid)) {
    throw new Error("Another Z.AI login is already waiting for authorization.");
  }
  const current = await currentDefaultHandler(runner, record.scheme).catch(() => "");
  if (current === record.bundleId) {
    await setDefaultHandler(runner, record.scheme, record.previousHandler || "none");
  }
  await unregisterApp(runner, record.appPath);
  await rm(record.appPath, { recursive: true, force: true });
  await rm(path, { force: true });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Login cancelled.");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function createDarwinUrlCallbackReceiver(
  options: DarwinUrlCallbackOptions
): Promise<DarwinUrlCallbackReceiver> {
  if (process.platform !== "darwin") {
    throw new Error("The native zcode:// callback receiver is only available on macOS.");
  }
  if (!/^[a-z][a-z0-9+.-]*$/u.test(options.scheme)) {
    throw new Error(`Invalid callback scheme: ${options.scheme}`);
  }

  const runner = options.runCommand ?? runCommand;
  const home = options.env?.HOME || homedir();
  await recoverStaleDarwinOAuthHandler({ ...options, runCommand: runner });

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const shortNonce = nonce.slice(0, 10);
  const bundleId = `${managedBundlePrefix}${nonce}`;
  const appPath = join(applicationsDirectory(home), `${managedAppPrefix}${shortNonce}.app`);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-oauth-"));
  const callbackPath = join(temporaryDirectory, "callback.url");
  const recovery = recoveryPath(home);
  let previousHandler = "";
  let handlerChanged = false;
  let disposePromise: Promise<void> | undefined;

  const cleanup = async (): Promise<void> => {
    const current = await currentDefaultHandler(runner, options.scheme).catch(() => "");
    if (handlerChanged && current === bundleId) {
      await setDefaultHandler(runner, options.scheme, previousHandler || "none").catch(() => {});
    }
    await unregisterApp(runner, appPath);
    await rm(appPath, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
    const record = await readRecovery(home);
    if (record?.bundleId === bundleId) await rm(recovery, { force: true });
  };

  try {
    previousHandler = await currentDefaultHandler(runner, options.scheme);
    await mkdir(applicationsDirectory(home), { recursive: true });
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(callbackPath, "", { mode: 0o600 });
    await chmod(callbackPath, 0o600);

    const compileArgs = ["-o", appPath];
    for (const line of callbackAppleScript(callbackPath, options.scheme, previousHandler)) {
      compileArgs.push("-e", line);
    }
    await checkedRun(runner, "/usr/bin/osacompile", compileArgs);

    const infoPlist = join(appPath, "Contents", "Info.plist");
    await checkedRun(runner, "/usr/bin/plutil", [
      "-insert",
      "CFBundleIdentifier",
      "-string",
      bundleId,
      infoPlist
    ]);
    await checkedRun(runner, "/usr/bin/plutil", [
      "-insert",
      "LSUIElement",
      "-bool",
      "true",
      infoPlist
    ]);
    await checkedRun(runner, "/usr/bin/plutil", [
      "-insert",
      "CFBundleURLTypes",
      "-json",
      JSON.stringify([{
        CFBundleTypeRole: "Viewer",
        CFBundleURLName: "ZCode CLI OAuth Callback",
        CFBundleURLSchemes: [options.scheme]
      }]),
      infoPlist
    ]);
    await checkedRun(runner, "/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
    await checkedRun(runner, launchServicesRegister, ["-f", appPath]);

    const record: RecoveryRecord = {
      appPath,
      bundleId,
      pid: process.pid,
      previousHandler,
      scheme: options.scheme
    };
    await writeFile(recovery, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await chmod(recovery, 0o600);
    await setDefaultHandler(runner, options.scheme, bundleId);
    handlerChanged = true;
    const registered = await currentDefaultHandler(runner, options.scheme);
    if (registered !== bundleId) throw new Error(`macOS did not activate the ${options.scheme} callback handler.`);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    dispose() {
      return disposePromise ??= cleanup();
    },
    async waitForCallback(signal, timeoutMs = defaultTimeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (signal?.aborted) throw abortReason(signal);
        const callback = await readFile(callbackPath, "utf8").catch(() => "");
        if (callback.trim()) return callback.trim();
        await delay(100, signal);
      }
      throw new Error("Authorization timed out. Please retry login.");
    }
  };
}
