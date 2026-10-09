import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { browserOpenCommand } from "../src/browser-open.ts";
import { hasRuntimeBrowserUrlOpening, patchRuntimeBrowserUrlOpening } from "../scripts/runtime-browser-patches.ts";

const source = `function label(fn){return fn}
function browser(platform,url){return platform==="darwin"?{executable:"open",args:[url]}:platform==="win32"?{executable:"cmd.exe",args:["/c","start","",url]}:{executable:"xdg-open",args:[url]}}
label(browser,"browserOpenCommand");
async function openUrl(url,options={}){let platform=options.platform??process.platform,command=browser(platform,url),spawnProcess=options.spawnProcess??require("node:child_process").spawn;let child=spawnProcess(command.executable,command.args,{detached:!0,stdio:"ignore",windowsHide:!0});return child}
label(openUrl,"openUrlInBrowser");`;

function loadBrowserRuntime() {
  return new Function("require", "__dirname", `${patchRuntimeBrowserUrlOpening(source)};return {browser,openUrl};`)(
    (id: string) => id === "node:path" ? { join } : { browserOpenCommand }, "/fixture"
  );
}

const urls = [
  "https://bigmodel.cn/login?appId=zcode&redirect=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&state=fixture-state",
  "https://chat.z.ai/api/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&response_type=code&client_id=fixture&state=fixture-state",
  "https://example.com/?value=%PATH%&state=中文 space 'quote' \"double\" $() `backtick` | < > ^ !",
  "https://example.com/?value='; throw 'URL executed as code'; #",
  "https://example.com/?value=‘’; throw ‘URL executed as code’; #"
];

function decodeLiteral(args: string[]): string {
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(args).toHaveLength(4);
  expect(args[3]).toMatch(/^[A-Za-z0-9+/]+=*$/u);
  const script = Buffer.from(args[3]!, "base64").toString("utf16le");
  const literal = /^Start-Process -FilePath \(\[Text.Encoding\]::UTF8.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/]*=*)'\)\)\)$/u.exec(script);
  expect(literal).not.toBeNull();
  return Buffer.from(literal![1]!, "base64").toString("utf8");
}

describe("browser URL command", () => {
  test.each(urls)("preserves the full URL as data in the Windows command: %s", url => {
    const command = browserOpenCommand("win32", url);
    expect(command.executable).toBe("powershell.exe");
    expect(decodeLiteral(command.args)).toBe(url);
  });

  test("preserves direct process arguments on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", urls[0]!)).toEqual({ executable: "open", args: [urls[0]] });
    expect(browserOpenCommand("linux", urls[0]!)).toEqual({ executable: "xdg-open", args: [urls[0]] });
  });

});

describe("runtime browser URL patch", () => {
  test("routes the native command builder through the bridge on every platform", () => {
    const { browser } = loadBrowserRuntime();
    expect(decodeLiteral(browser("win32", urls[0]).args)).toBe(urls[0]);
    expect(browser("darwin", urls[0])).toEqual({ executable: "open", args: [urls[0]] });
    expect(browser("linux", urls[0])).toEqual({ executable: "xdg-open", args: [urls[0]] });
  });

  test.each(["win32", "darwin", "linux"] as const)("uses the appropriate browser process options on %s", async platform => {
    const { openUrl } = loadBrowserRuntime();
    let called = false;
    await openUrl(urls[0], { platform, spawnProcess: (_executable: string, _args: string[], options: unknown) => {
      called = true;
      expect(options).toEqual({ detached: platform !== "win32", stdio: "ignore", windowsHide: true });
    } });
    expect(called).toBe(true);
  });

  test.skipIf(process.platform !== "win32")("Node executes the PowerShell browser action with the runtime spawn options", () => {
    // Run under Node, as the packaged CLI does. A detached PowerShell process can
    // exit successfully without executing any script; spawnSync alone misses it.
    // Replace only Start-Process, preserving real parsing and URL transport.
    const script = `
      const assert = require("node:assert/strict");
      const { spawn } = require("node:child_process");
      const commands = ${JSON.stringify(urls.map(url => browserOpenCommand("win32", url)))};
      const urls = ${JSON.stringify(urls)};
      const bridge = { browserOpenCommand: (_platform, url) => commands[urls.indexOf(url)] };
      const { openUrl } = new Function("require", "__dirname", ${JSON.stringify(`${patchRuntimeBrowserUrlOpening(source)};return {openUrl};`)})(
        id => id === "node:path" ? require(id) : bridge, "/fixture"
      );
      (async () => {
        for (const url of urls) {
          let completed;
          await openUrl(url, { platform: "win32", spawnProcess: (executable, args, options) => {
            const action = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\\n'
              + 'function Start-Process { param([string]$FilePath) ConvertTo-Json -Compress -InputObject $FilePath }\\n'
              + Buffer.from(args[3], "base64").toString("utf16le");
            const child = spawn(executable, [...args.slice(0, 3), Buffer.from(action, "utf16le").toString("base64")], {
              ...options, stdio: ["ignore", "pipe", "pipe"]
            });
            completed = new Promise((resolve, reject) => {
              let stdout = "", stderr = "";
              child.stdout.on("data", chunk => stdout += chunk);
              child.stderr.on("data", chunk => stderr += chunk);
              child.once("error", reject);
              child.once("close", code => {
                try {
                  assert.equal(code, 0, stderr);
                  assert.equal(JSON.parse(stdout.replace(/^\\uFEFF/u, "").trim()), url);
                  resolve();
                } catch (error) { reject(error); }
              });
            });
            return child;
          } });
          await completed;
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(Bun.which("node")!, ["--eval", script], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 35_000);

  test("is idempotent, tolerates minifier renaming, and rejects changed or ambiguous anchors", () => {
    const renamed = source.replaceAll("browser(", "$browser(").replaceAll("label(browser,", "label($browser,")
      .replaceAll("options", "$options").replaceAll("platform", "$platform").replace("$options.$platform", "$options.platform").replace("process.$platform", "process.platform");
    for (const original of [source, renamed]) {
      const patched = patchRuntimeBrowserUrlOpening(original);
      expect(hasRuntimeBrowserUrlOpening(original)).toBe(false);
      expect(hasRuntimeBrowserUrlOpening(patched)).toBe(true);
      expect(patchRuntimeBrowserUrlOpening(patched)).toBe(patched);
    }
    for (const broken of ["incompatible runtime", source + source, source.replace('"cmd.exe"', '"other.exe"'),
      source.replace("detached:!0", "detached:!1"), source.replace("options.platform??process.platform", "process.platform"),
      patchRuntimeBrowserUrlOpening(source).replace(".browserOpenCommand(platform,url)", ".browserOpenCommand(url,platform)")]) {
      expect(hasRuntimeBrowserUrlOpening(broken)).toBe(false);
      expect(() => patchRuntimeBrowserUrlOpening(broken)).toThrow("incompatible with browser URL opening");
    }
  });

  test("upgrades a runtime that already has the encoded URL command patch", () => {
    const patched = patchRuntimeBrowserUrlOpening(source);
    const previous = patched.replace('detached:platform!=="win32"', "detached:!0");
    expect(hasRuntimeBrowserUrlOpening(previous)).toBe(false);
    expect(patchRuntimeBrowserUrlOpening(previous)).toBe(patched);
  });
});
