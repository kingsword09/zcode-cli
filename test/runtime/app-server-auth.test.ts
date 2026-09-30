import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ensureCliSettings, cliSettingsPath } from "../../src/model-access.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");
const tls = join(root, "test/fixtures/app-server-auth");
const providerId = "account:zai-individual-coding-plan";
const credentialKey = `account-provider:coding-plan:${providerId}:account:fixture-user:api-key`;

interface Snapshot {
  session: { sessionId: string };
  settings: { model: { available: unknown[] } };
}
interface TerminalEvent { type: string; payload?: { error?: { message?: string } } }

async function withServer(
  mode: string | undefined,
  credentials: "valid" | "missing" | "corrupt",
  check: (fixture: {
    request: <T = unknown>(method: string, params: object) => Promise<T>;
    turn: (sessionId: string) => Promise<TerminalEvent>;
    create: () => Promise<Snapshot>;
    accountConfig: object;
    modelRequests: string[];
    authRequests: string[];
    events: object[];
    rotateKey: () => Promise<void>;
    rejectHostAuth: () => void;
  }) => Promise<void>
) {
  const home = await mkdtemp(join(tmpdir(), "zcode-app-server-auth-"));
  const modelRequests: string[] = [], authRequests: string[] = [], events: object[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(join(tls, "localhost-key.pem")), cert: Bun.file(join(tls, "localhost-cert.pem")) },
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("", { status: 404 });
      modelRequests.push(request.headers.get("authorization") ?? "");
      const body = await request.json() as { model: string; stream?: boolean };
      if (!body.stream) return Response.json({ id: "fixture", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "APP_SERVER_AUTH_OK" }, finish_reason: "stop" }] });
      const chunks = [{ role: "assistant", content: "APP_SERVER_AUTH_OK" }, {}].map((delta, index) => (
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }] })}\n\n`
      ));
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
  });
  let stop: (() => Promise<void>) | undefined;
  try {
    const env: NodeJS.ProcessEnv = { ...runtimeTestEnv(home), NODE_EXTRA_CA_CERTS: join(tls, "localhost-cert.pem"), ZCODE_BASE_URL: server.url.origin,
      ...(mode === undefined ? {} : { ZCODE_APP_SERVER_AUTH_MODE: mode }) };
    const builtin = await Bun.file(join(root, "vendor/provider/zcode-builtin.json")).json();
    const provider = builtin.config.providerConfigRules.providerRules.find((item: { providerId: string }) => item.providerId === providerId);
    provider.config.api = { type: "openai-chat-completions", baseUrl: `${server.url.origin}/v1` };
    const builtinPath = join(home, "builtin.json");
    await writeFile(builtinPath, JSON.stringify(builtin));
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;
    await ensureCliSettings(env);
    const settings = await Bun.file(cliSettingsPath(env)).json();
    settings.features.mcp = false;
    settings.plugins.enabled = false;
    settings.skills.enabled = false;
    settings.memory = { use: false, write: false, autoConsolidate: false };
    await writeFile(cliSettingsPath(env), JSON.stringify(settings));
    await mkdir(join(home, ".zcode/v2"), { recursive: true });
    await writeFile(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!, JSON.stringify({ schemaVersion: 1,
      config: { defaultModelSelection: { providerId, modelId: "GLM-5.3" } } }));
    const credentialsPath = join(home, ".zcode/v2/credentials.json");
    const localCredentials = credentials === "missing" ? {} : {
      [`account-provider:${providerId}:identity`]: credentials === "corrupt" ? "enc:v1:broken" : "fixture-user",
      [credentialKey]: "local-fixture-key"
    };
    await writeFile(credentialsPath, JSON.stringify(localCredentials));
    const savedCredentials = await readFile(credentialsPath, "utf8");
    const child = spawn(Bun.which("node")!, [join(root, "vendor/zcode.cjs"), "app-server"], { cwd: home, env, stdio: "pipe" });
    let stderr = "", nextId = 0, hostAuthFailure = false;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let turnEnded: ((event: TerminalEvent) => void) | undefined;
    let turnRejected: ((error: Error) => void) | undefined;
    let failure: Error | undefined;
    child.stderr.on("data", data => { stderr += data.toString(); });
    const fail = (error: Error) => {
      failure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      turnRejected?.(error);
    };
    child.once("error", fail);
    const exited = new Promise<void>(resolve => child.once("exit", code => {
      fail(new Error(`app-server exited (${code}): ${stderr.slice(-3000)}`));
      resolve();
    }));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      const item = JSON.parse(line);
      const reply = (result: object) => child.stdin.write(`${JSON.stringify({ id: item.id, result })}\n`);
      if (item.id && item.method === "session/requestRuntimePreferences") {
        reply({ nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false });
      } else if (item.id && item.method === "interaction/requestProviderRuntimeHeaders") {
        authRequests.push(item.params.providerId);
        reply(hostAuthFailure ? { headersApplied: false, errorMessage: "host-auth-fixture-failed" }
          : { headersApplied: true, requestAuth: { apiKey: "host-fixture-key" } });
      } else if (pending.has(item.id)) {
        const waiter = pending.get(item.id)!;
        pending.delete(item.id);
        item.error ? waiter.reject(new Error(item.error.message)) : waiter.resolve(item.result);
      } else {
        events.push(item);
        if (item.method === "session/event" && ["turn.completed", "turn.failed"].includes(item.params?.type)) turnEnded?.(item.params);
      }
    });
    const deadline = setTimeout(() => {
      fail(new Error(`app-server auth test timed out: ${stderr.slice(-3000)}`));
      child.kill("SIGKILL");
    }, 25_000);
    stop = async () => {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(kill);
      lines.close();
    };
    const request = <T = unknown>(method: string, params: object) => new Promise<T>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    await check({ request, modelRequests, authRequests, events,
      create: () => request<Snapshot>("session/create", { workspace: { workspacePath: home, workspaceKey: home }, titleGenerationEnabled: false }),
      // The native built-in snapshot revision includes the active file identity.
      accountConfig: { revision: "host-fixture-1", basedOnZCodeBuiltinRevision: `zcode-builtin:${builtin.revision}:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`,
        providers: { [providerId]: { access: { type: "zhipu-account", entitled: true } } },
        states: { [providerId]: { availability: "available", entitled: true, current: true } } },
      rotateKey: () => writeFile(credentialsPath, JSON.stringify({ ...localCredentials, [credentialKey]: "rotated-fixture-key" })),
      rejectHostAuth: () => { hostAuthFailure = true; },
      async turn(sessionId) {
        await request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
        const terminal = new Promise<TerminalEvent>((resolve, reject) => { turnEnded = resolve; turnRejected = reject; });
        // Attach the terminal waiter before sending, including very early errors.
        const [, event] = await Promise.all([request("session/send", { sessionId, content: "Reply APP_SERVER_AUTH_OK without using tools." }), terminal]);
        turnEnded = undefined;
        turnRejected = undefined;
        return event;
      }
    });
    if (mode === "host") expect(await readFile(credentialsPath, "utf8")).toBe(savedCredentials);
  } finally {
    await stop?.();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

test("app-server defaults to local login and reads rotated credentials on the next turn", async () => {
  await withServer(undefined, "valid", async fixture => {
    await expect(fixture.request("provider/updateAccountConfig", fixture.accountConfig)).rejects.toThrow("Host");
    const snapshot = await fixture.create();
    expect(snapshot.settings.model.available.length).toBeGreaterThan(0);
    expect((await fixture.turn(snapshot.session.sessionId)).type).toBe("turn.completed");
    await fixture.rotateKey();
    expect((await fixture.turn(snapshot.session.sessionId)).type).toBe("turn.completed");
    expect(fixture.modelRequests).toEqual(["Bearer local-fixture-key", "Bearer rotated-fixture-key"]);
    expect(fixture.authRequests).toEqual([]);
    expect(JSON.stringify(fixture.events)).toContain("APP_SERVER_AUTH_OK");
  });
}, 35_000);

test.each(["valid", "corrupt"] as const)("host mode keeps account and request auth with the client (local credentials: %s)", async credentials => {
  await withServer("host", credentials, async fixture => {
    expect(await fixture.request("provider/updateAccountConfig", fixture.accountConfig)).toMatchObject({ status: "received" });
    const snapshot = await fixture.create();
    expect(snapshot.settings.model.available.length).toBeGreaterThan(0);
    expect((await fixture.turn(snapshot.session.sessionId)).type).toBe("turn.completed");
    expect(fixture.authRequests).toEqual([providerId]);
    expect(fixture.modelRequests).toEqual(["Bearer host-fixture-key"]);
    fixture.rejectHostAuth();
    expect((await fixture.turn(snapshot.session.sessionId)).type).toBe("turn.failed");
    expect(fixture.modelRequests).toHaveLength(1);
  });
}, 35_000);

test("missing local credentials do not trigger host authentication", async () => {
  await withServer("standalone", "missing", async fixture => {
    const snapshot = await fixture.create();
    expect(snapshot.settings.model.available).toEqual([]);
    expect((await fixture.turn(snapshot.session.sessionId)).type).toBe("turn.failed");
    expect(fixture.modelRequests).toEqual([]);
    expect(fixture.authRequests).toEqual([]);
  });
}, 35_000);

test("an invalid auth mode prevents app-server startup", async () => {
  await withServer("hosst", "valid", async fixture => {
    await expect(fixture.request("session/list", {})).rejects.toThrow("ZCODE_APP_SERVER_AUTH_MODE must be standalone or host");
    expect(fixture.modelRequests).toEqual([]);
  });
}, 35_000);
