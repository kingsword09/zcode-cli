import { spawn } from "node:child_process";
import { agentReportSequence } from "./report-sequence.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const SOURCE = "herdr-zcode";
const AGENT = "zcode";
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,128}$/u;
const STATE_BY_EVENT = new Map([
  ["SessionStart", "idle"],
  ["UserPromptSubmit", "working"],
  ["PermissionRequest", "blocked"],
  ["PostToolUse", "working"],
  ["PostToolUseFailure", "working"],
  ["Stop", "idle"]
]);

async function readHookInput() {
  const chunks = [];
  let size = 0;

  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_INPUT_BYTES) {
      process.stdin.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function reportState(input) {
  const { HERDR_BIN_PATH: binary, HERDR_ENV, HERDR_PANE_ID: pane } = process.env;
  if (HERDR_ENV !== "1" || !binary || !pane || !input || typeof input !== "object") return;

  const state = STATE_BY_EVENT.get(input.hook_event_name);
  if (!state) return;

  const args = [
    "pane",
    "report-agent",
    pane,
    "--source",
    SOURCE,
    "--agent",
    AGENT,
    "--state",
    state,
    "--seq",
    agentReportSequence().toString()
  ];

  if (state === "blocked") args.push("--message", "Waiting for a ZCode permission decision");

  const session = typeof input.session_id === "string" && SESSION_ID.test(input.session_id)
    ? input.session_id
    : undefined;
  // `herdr pane report-agent` takes the session id as a flag and has no
  // trailing-command support: a `-- zcode --resume <id>` tail makes the
  // daemon refuse the whole report ("unknown option: --"), so on CLIs that
  // pass a session id (3.18.1+) every report dies and the pane reads
  // unknown. The flag alone is the contract.
  if (session) args.push("--agent-session-id", session);

  try {
    const child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Reporting is advisory and must not interrupt the agent session.
  }
}

try {
  reportState(await readHookInput());
} catch {
  // Ignore malformed input and report failures; ZCode remains usable without Herdr.
}
