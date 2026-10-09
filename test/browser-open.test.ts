import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { browserOpenCommand } from "../src/browser-open.ts";
import { hasRuntimeBrowserUrlOpening, patchRuntimeBrowserUrlOpening } from "../scripts/runtime-browser-patches.ts";

const source = `function label(fn){return fn}
function browser(platform,url){return platform==="darwin"?{executable:"open",args:[url]}:platform==="win32"?{executable:"cmd.exe",args:["/c","start","",url]}:{executable:"xdg-open",args:[url]}}
label(browser,"browserOpenCommand");`;

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

  test.skipIf(process.platform !== "win32")("PowerShell passes every URL intact to Start-Process without evaluating its contents", () => {
    for (const url of urls) {
      const command = browserOpenCommand("win32", url);
      // Replace only the OS browser action, exercising the actual PowerShell
      // parser and native process argument transport without opening a browser.
      const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Start-Process { param([string]$FilePath) ConvertTo-Json -Compress -InputObject $FilePath }
${Buffer.from(command.args[3]!, "base64").toString("utf16le")}`;
      const result = spawnSync(command.executable, [...command.args.slice(0, 3), Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 10_000, windowsHide: true
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.replace(/^\uFEFF/u, "").trim())).toBe(url);
    }
  }, 45_000);
});

describe("runtime browser URL patch", () => {
  test("routes the native command builder through the bridge on every platform", () => {
    const browser = new Function("require", "__dirname", `${patchRuntimeBrowserUrlOpening(source)};return browser;`)(
      (id: string) => id === "node:path" ? { join } : { browserOpenCommand }, "/fixture"
    );
    expect(decodeLiteral(browser("win32", urls[0]).args)).toBe(urls[0]);
    expect(browser("darwin", urls[0])).toEqual({ executable: "open", args: [urls[0]] });
    expect(browser("linux", urls[0])).toEqual({ executable: "xdg-open", args: [urls[0]] });
  });

  test("is idempotent, tolerates minifier renaming, and rejects changed or ambiguous anchors", () => {
    const renamed = source.replaceAll("browser(", "$browser(").replaceAll("label(browser,", "label($browser,");
    for (const original of [source, renamed]) {
      const patched = patchRuntimeBrowserUrlOpening(original);
      expect(hasRuntimeBrowserUrlOpening(original)).toBe(false);
      expect(hasRuntimeBrowserUrlOpening(patched)).toBe(true);
      expect(patchRuntimeBrowserUrlOpening(patched)).toBe(patched);
    }
    for (const broken of ["incompatible runtime", source + source, source.replace('"cmd.exe"', '"other.exe"'),
      patchRuntimeBrowserUrlOpening(source).replace(".browserOpenCommand(platform,url)", ".browserOpenCommand(url,platform)")]) {
      expect(hasRuntimeBrowserUrlOpening(broken)).toBe(false);
      expect(() => patchRuntimeBrowserUrlOpening(broken)).toThrow("incompatible with browser URL opening");
    }
  });
});
