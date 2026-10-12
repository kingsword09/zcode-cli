#!/usr/bin/env bun

import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTestEnv } from "./runtime-test-env.ts";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--regular")) {
  throw new Error("Usage: bun run check:tui:focus:manual [--regular]");
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Open this demo in an interactive terminal, not a pipe or redirected log.");
}

const root = join(import.meta.dir, "..");
const home = await mkdtemp(join(tmpdir(), "zcode-focus-manual-"));
let realFocus = "unknown";
let realFocusReports = 0;
let focusReportTail = "";
let injectingFocus = false;

function observeFocus(data: string | Buffer): void {
  if (injectingFocus) return;
  const input = focusReportTail + data.toString();
  for (const report of input.match(/\x1b\[[IO]/gu) ?? []) {
    realFocus = report.endsWith("I") ? "focused" : "unfocused";
    realFocusReports += 1;
  }
  focusReportTail = input.slice(-2);
}

function simulateFocus(focused: boolean): void {
  injectingFocus = true;
  try {
    process.stdin.emit("data", focused ? "\x1b[I" : "\x1b[O");
  } finally {
    injectingFocus = false;
  }
}

try {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ZCODE_")) delete process.env[key];
  }
  Object.assign(process.env, runtimeTestEnv(home, root), {
    NO_COLOR: "",
    ZCODE_TUI_MODE: args.includes("--regular") ? "regular" : "fullscreen",
    ZCODE_TUI_NOTIFICATION_METHOD: "off"
  });
  const { runTui } = await import("../packages/zcode-tui/src/index.ts");
  process.stdin.on("data", observeFocus);
  await runTui({
    version: "focus-manual",
    workspaceDirectory: root,
    initialModel: "offline/focus-demo",
    loadSessionTranscript: async () => [{
      role: "agent",
      content: [
        "## 光标隐藏：离线交互演示",
        "输入 /focus-demo 回车：光标显示 3 秒 → 隐藏 5 秒 → 恢复。观察底部输入框左侧，不要切走窗口。",
        "真实测试：输入几个字但不提交，切到其他应用或终端窗格，观察原输入框，再切回来。",
        "输入 /focus-status 查看是否收到真实焦点报告；unknown 表示尚未收到报告，不能据此判定隐藏失败。",
        "搜索测试：输入 /search React；正文白底 React 应始终保留，只有输入光标在失焦时隐藏。",
        "全屏搜索弹层：Ctrl+Shift+F，输入 React 后再切换窗口。模拟演示开始后的前 3 秒也可以打开弹层。",
        "搜索样本：React hooks / React state / React effects。",
        "本演示不调用模型、不读取账号，配置保存在临时目录。输入 /exit 退出。"
      ].join("\n\n")
    }],
    slashCommands: [
      { name: "focus-demo", description: "显示 3 秒、模拟失焦隐藏 5 秒、恢复光标" },
      { name: "focus-status", description: "查看真实终端焦点报告（不统计模拟事件）" }
    ],
    submitPrompt: async (input, options) => {
      if (input === "/focus-status") {
        return { response: `真实焦点报告：${realFocusReports} 次；最后状态：${realFocus}。模拟事件不计入此统计。` };
      }
      if (input !== "/focus-demo") return { response: "离线演示：输入 /focus-demo 或 /focus-status。" };
      const phase = async (text: string): Promise<void> => {
        await options.onEvent?.({ type: "model.streaming", payload: { kind: "text_delta", delta: text } });
      };
      simulateFocus(true);
      try {
        await phase("[1/3 FOCUSED] 光标显示，3 秒后模拟失焦。\n");
        await delay(3_000, undefined, { signal: options.abortSignal });
        simulateFocus(false);
        await phase("[2/3 UNFOCUSED] 光标应隐藏，保持 5 秒；文字和搜索高亮不变。\n");
        await delay(5_000, undefined, { signal: options.abortSignal });
      } finally {
        simulateFocus(true);
      }
      await phase("[3/3 FOCUSED] 光标应恢复。模拟通过后，请切换窗口验证真实焦点报告。");
      return {};
    }
  });
} finally {
  process.stdin.removeListener("data", observeFocus);
  await rm(home, { recursive: true, force: true });
}
console.log(`真实焦点报告：${realFocusReports} 次；最后状态：${realFocus}。临时配置已清理。`);
