import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDarwinUrlCallbackReceiver,
  recoverStaleDarwinOAuthHandler,
  type CommandRunner
} from "../src/darwin-oauth-callback.ts";

type FailureTarget =
  | "read_handler"
  | "compile"
  | "bundle_id"
  | "ui_element"
  | "url_types"
  | "codesign"
  | "launch_services"
  | "activate_handler"
  | "verify_handler";

interface FakeRunnerOptions {
  failure?: FailureTarget;
  initialHandler?: string;
  mismatchOnVerify?: boolean;
}

function fakeRunner(options: FakeRunnerOptions = {}): CommandRunner {
  let currentHandler = options.initialHandler ?? "com.example.previous";
  let handlerReads = 0;
  let handlerWrites = 0;

  return async (command, args) => {
    let target: FailureTarget | undefined;
    if (command === "/usr/bin/osascript") {
      const settingHandler = args.length === 6;
      if (settingHandler) {
        handlerWrites += 1;
        target = handlerWrites === 1 ? "activate_handler" : undefined;
        if (options.failure !== target) currentHandler = args.at(-1) ?? "none";
      } else {
        handlerReads += 1;
        target = handlerReads === 1
          ? "read_handler"
          : handlerReads === 2
            ? "verify_handler"
            : undefined;
      }
    } else if (command === "/usr/bin/osacompile") {
      target = "compile";
    } else if (command === "/usr/bin/plutil") {
      if (args[1] === "CFBundleIdentifier") target = "bundle_id";
      if (args[1] === "LSUIElement") target = "ui_element";
      if (args[1] === "CFBundleURLTypes") target = "url_types";
    } else if (command === "/usr/bin/codesign") {
      target = "codesign";
    } else if (command.endsWith("/lsregister") && args[0] === "-f") {
      target = "launch_services";
    }

    if (target && options.failure === target) {
      return { code: 1, stderr: `simulated ${target} failure`, stdout: "" };
    }
    if (command === "/usr/bin/osascript") {
      if (args.length === 6) return { code: 0, stderr: "", stdout: "0" };
      const handler = options.mismatchOnVerify && handlerReads === 2
        ? "com.example.stale"
        : currentHandler;
      return { code: 0, stderr: "", stdout: handler };
    }
    return { code: 0, stderr: "", stdout: "" };
  };
}

async function withTemporaryHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-oauth-test-"));
  try {
    return await action(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function createReceiver(home: string, runCommand: CommandRunner) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    return createDarwinUrlCallbackReceiver({
      env: { HOME: home },
      runCommand,
      scheme: "zcode"
    });
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

describe("native macOS OAuth callback diagnostics", () => {
  test("labels every external setup step", async () => {
    const cases: Array<[FailureTarget, string]> = [
      ["read_handler", "reading current OAuth callback handler"],
      ["compile", "compiling OAuth callback app"],
      ["bundle_id", "setting CFBundleIdentifier"],
      ["ui_element", "setting LSUIElement"],
      ["url_types", "setting CFBundleURLTypes"],
      ["codesign", "ad-hoc codesigning callback app"],
      ["launch_services", "registering callback app with LaunchServices"],
      ["activate_handler", "activating OAuth callback handler"],
      ["verify_handler", "verifying OAuth callback handler"]
    ];

    for (const [failure, step] of cases) {
      await withTemporaryHome(async (home) => {
        try {
          await createReceiver(home, fakeRunner({ failure }));
          throw new Error(`Expected ${failure} to fail.`);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toStartWith(`${step}: `);
          expect((error as Error).cause).toBeInstanceOf(Error);
        }
      });
    }
  });

  test("labels stale-handler restoration failures", async () => {
    await withTemporaryHome(async (home) => {
      const appPath = join(home, "Applications", "ZCode CLI OAuth Callback stale.app");
      const recoveryDirectory = join(home, ".zcode", "cli");
      await mkdir(recoveryDirectory, { recursive: true });
      await writeFile(join(recoveryDirectory, "oauth-handler-recovery.json"), JSON.stringify({
        appPath,
        bundleId: "dev.zcode.cli.oauth-callback.stale",
        pid: process.pid,
        previousHandler: "com.example.previous",
        scheme: "zcode"
      }));

      await expect(recoverStaleDarwinOAuthHandler({
        env: { HOME: home },
        runCommand: fakeRunner({
          failure: "activate_handler",
          initialHandler: "dev.zcode.cli.oauth-callback.stale"
        }),
        scheme: "zcode"
      })).rejects.toThrow(/^restoring stale OAuth callback handler: /);
    });
  });

  test("gives actionable handler activation and timeout guidance", async () => {
    await withTemporaryHome(async (home) => {
      await expect(createReceiver(home, fakeRunner({ mismatchOnVerify: true }))).rejects.toThrow(
        /Remove stale `ZCode CLI OAuth Callback \*\.app` entries from `~\/Applications`/
      );

      const receiver = await createReceiver(home, fakeRunner());
      try {
        await expect(receiver.waitForCallback(undefined, 0)).rejects.toThrow(
          /remove it before retrying/
        );
      } finally {
        await receiver.dispose();
      }
    });
  });
});
