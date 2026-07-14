import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  createDarwinUrlCallbackReceiver,
  type DarwinUrlCallbackReceiver
} from "./darwin-oauth-callback.ts";

const authorizeEndpoint = "https://chat.z.ai/api/oauth/authorize";
const clientId = "client_P8X5CMWmlaRO9gyO-KSqtg";
const redirectUri = "zcode://zai-auth/callback";
const supportedLoginFlags = new Set(["--json", "--no-browser", "--oauth", "--verbose"]);

export interface ZaiOAuthInvocation {
  json: boolean;
  noBrowser: boolean;
  runtimeArgs: string[];
}

export interface ZaiOAuthCallback {
  callbackUrl: string;
  code: string;
  state: string;
}

export interface OfficialLoginPayload {
  callbackUrl: string;
  state: string;
}

interface BrowserOpenResult {
  opened: boolean;
  reason?: string;
}

interface WritableOutput {
  write(value: string): unknown;
}

export interface ZaiOAuthLoginOptions {
  abortSignal?: AbortSignal;
  completeLogin(payload: OfficialLoginPayload, runtimeArgs: string[]): Promise<number>;
  createReceiver?: (options: {
    env: NodeJS.ProcessEnv;
    scheme: string;
  }) => Promise<DarwinUrlCallbackReceiver>;
  env?: NodeJS.ProcessEnv;
  invocation: ZaiOAuthInvocation;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  output?: WritableOutput;
  platform?: NodeJS.Platform;
  state?: string;
  timeoutMs?: number;
}

export function classifyZaiOAuthInvocation(args: string[]): ZaiOAuthInvocation | null {
  const positionals = args.filter((argument) => !argument.startsWith("-"));
  if (positionals.length !== 1 || positionals[0] !== "login") return null;
  if (args.some((argument) => argument.startsWith("-") && !supportedLoginFlags.has(argument))) {
    return null;
  }
  return {
    json: args.includes("--json"),
    noBrowser: args.includes("--no-browser"),
    runtimeArgs: args.filter((argument) => argument !== "--oauth")
  };
}

export function buildZaiAuthorizeUrl(state: string): string {
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state
  }).toString();
  return url.toString();
}

function statesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeAuthorizationError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 300);
}

export function parseZaiOAuthCallback(callbackUrl: string, expectedState: string): ZaiOAuthCallback {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("Z.AI returned an invalid OAuth callback URL.");
  }
  const path = `/${url.pathname.replace(/^\/+|\/+$/gu, "")}`;
  if (url.protocol !== "zcode:" || url.hostname !== "zai-auth" || path !== "/callback") {
    throw new Error("Z.AI returned an unexpected OAuth callback target.");
  }
  const state = url.searchParams.get("state") || "";
  if (!state || !statesMatch(state, expectedState)) {
    throw new Error("Z.AI OAuth state did not match. Please retry login.");
  }
  const authorizationError = url.searchParams.get("error_description")
    || url.searchParams.get("error");
  if (authorizationError) {
    throw new Error(`Z.AI authorization failed: ${safeAuthorizationError(authorizationError)}`);
  }
  const code = url.searchParams.get("code") || url.searchParams.get("authCode") || "";
  if (!code) throw new Error("Z.AI OAuth callback did not include an authorization code.");
  return { callbackUrl, code, state };
}

async function openBrowser(url: string): Promise<BrowserOpenResult> {
  const child = Bun.spawn(["/usr/bin/open", url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe"
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text()
  ]);
  return code === 0
    ? { opened: true }
    : { opened: false, reason: stderr.trim() || `open exited with status ${code}` };
}

export async function runZaiOAuthLogin(options: ZaiOAuthLoginOptions): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      "Z.AI browser login requires macOS for the registered zcode:// callback. "
      + "Use the Z.AI Coding Plan API Key option in /login on this platform."
    );
  }

  const env = options.env ?? process.env;
  const state = options.state ?? randomBytes(32).toString("hex");
  const output = options.output ?? process.stdout;
  const createReceiver = options.createReceiver ?? ((receiverOptions) => (
    createDarwinUrlCallbackReceiver(receiverOptions)
  ));
  const receiver = await createReceiver({ env, scheme: "zcode" });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await receiver.dispose();
  };

  try {
    const authorizeUrl = buildZaiAuthorizeUrl(state);
    if (options.invocation.noBrowser) {
      output.write(`Open this URL to sign in:\n${authorizeUrl}\nWaiting for the zcode:// callback...\n`);
    } else {
      output.write(`Opening browser for Z.AI authorization.\nFallback URL:\n${authorizeUrl}\n`);
      const result = await (options.openBrowser ?? openBrowser)(authorizeUrl);
      if (!result.opened) {
        output.write(`Browser open failed: ${result.reason ?? "unknown error"}\nOpen the fallback URL manually.\n`);
      }
    }

    const callbackUrl = await receiver.waitForCallback(options.abortSignal, options.timeoutMs);
    parseZaiOAuthCallback(callbackUrl, state);
    await dispose();
    output.write("Authorization received. Completing official ZCode setup...\n");
    return await options.completeLogin({ callbackUrl, state }, options.invocation.runtimeArgs);
  } finally {
    await dispose();
  }
}
