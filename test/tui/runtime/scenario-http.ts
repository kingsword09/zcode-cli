import {
  HttpResponse,
  http,
  type HttpResponseInit,
  type JsonBodyType
} from "msw";
import { setupServer, type SetupServer } from "msw/node";

import { ScenarioRuntimeJournal } from "./scenario-runtime.ts";

const REQUEST_BODY_JOURNAL_LIMIT = 16_384;
const SENSITIVE_HEADER = /(?:authorization|cookie|token|api[-_]?key|secret)/iu;

export type ScenarioHttpMethod =
  | "ALL"
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT";

export interface ScenarioHttpRequestContext {
  readonly call: number;
  readonly cookies: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly request: Request;
  readonly routeId: string;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export type ScenarioHttpValue<T> =
  | T
  | ((context: ScenarioHttpRequestContext) => T | Promise<T>);

interface ScenarioHttpResponseBase extends Omit<HttpResponseInit, "type"> {
  delayMilliseconds?: number;
}

export interface ScenarioHttpJsonResponse extends ScenarioHttpResponseBase {
  type: "json";
  body: JsonBodyType;
}

export interface ScenarioHttpTextResponse extends ScenarioHttpResponseBase {
  type: "text";
  body?: string;
}

export interface ScenarioHttpEmptyResponse extends ScenarioHttpResponseBase {
  type: "empty";
}

export interface ScenarioHttpNetworkError {
  type: "networkError";
}

export type ScenarioHttpResponse =
  | ScenarioHttpEmptyResponse
  | ScenarioHttpJsonResponse
  | ScenarioHttpNetworkError
  | ScenarioHttpTextResponse;

export interface ScenarioHttpRoute {
  id: string;
  method: ScenarioHttpMethod;
  url: string | RegExp;
  expectedCalls?: number;
  assert?: (context: ScenarioHttpRequestContext) => void | Promise<void>;
  response: ScenarioHttpValue<ScenarioHttpResponse>;
}

export interface ScenarioHttpDefinition {
  routes: readonly ScenarioHttpRoute[];
  journal?: ScenarioRuntimeJournal;
  journalPath?: string;
}

export interface ScenarioHttpMock extends Disposable {
  readonly journal: ScenarioRuntimeJournal;
  assertSatisfied(): void;
  calls(routeId: string): number;
  close(): void;
  start(): void;
}

async function scenarioHttpValue<T>(
  value: ScenarioHttpValue<T>,
  context: ScenarioHttpRequestContext
): Promise<T> {
  if (typeof value !== "function") return value;
  return await (value as (context: ScenarioHttpRequestContext) => T | Promise<T>)(context);
}

function validateDefinition(definition: ScenarioHttpDefinition): void {
  if (definition.journal && definition.journalPath) {
    throw new Error("Scenario HTTP mock accepts either journal or journalPath, not both.");
  }
  const ids = new Set<string>();
  for (const route of definition.routes) {
    if (!route.id || ids.has(route.id)) {
      throw new Error(`Scenario HTTP route id must be unique: ${route.id || "(empty)"}`);
    }
    ids.add(route.id);
    if (
      route.expectedCalls !== undefined
      && (!Number.isSafeInteger(route.expectedCalls) || route.expectedCalls < 0)
    ) {
      throw new Error(`Scenario HTTP route "${route.id}" has an invalid expectedCalls value.`);
    }
  }
}

function createRequestContext(
  route: ScenarioHttpRoute,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
  cookies: Record<string, string>,
  call: number
): ScenarioHttpRequestContext {
  return {
    call,
    cookies,
    params,
    request,
    routeId: route.id,
    async json<T = unknown>(): Promise<T> {
      return await request.clone().json() as T;
    },
    async text(): Promise<string> {
      return await request.clone().text();
    }
  };
}

async function requestDetail(
  route: ScenarioHttpRoute,
  request: Request,
  call: number
): Promise<Record<string, unknown>> {
  const body = await request.clone().text();
  const headers = Object.fromEntries(
    [...request.headers].map(([name, value]) => [
      name,
      SENSITIVE_HEADER.test(name) ? "[redacted]" : value
    ])
  );
  return {
    body: body.length > REQUEST_BODY_JOURNAL_LIMIT
      ? `${body.slice(0, REQUEST_BODY_JOURNAL_LIMIT)}…`
      : body,
    bodyTruncated: body.length > REQUEST_BODY_JOURNAL_LIMIT,
    call,
    headers,
    method: request.method,
    routeId: route.id,
    url: request.url
  };
}

function responseInit(response: ScenarioHttpResponseBase): HttpResponseInit {
  const { delayMilliseconds: _, ...init } = response;
  return init;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`Scenario HTTP response has an invalid delay: ${milliseconds}`);
  }
  if (milliseconds === 0) return;
  signal.throwIfAborted();
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Scenario HTTP request aborted", "AbortError"));
    };
    function finish() {
      signal.removeEventListener("abort", abort);
      resolveWait();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createResponse(response: ScenarioHttpResponse): Response {
  if (response.type === "networkError") return HttpResponse.error();
  const init = responseInit(response);
  if (response.type === "json") return HttpResponse.json(response.body, init);
  if (response.type === "text") return HttpResponse.text(response.body, init);
  return new HttpResponse(null, init);
}

function responseDetail(response: ScenarioHttpResponse): Record<string, unknown> {
  if (response.type === "networkError") return { type: response.type };
  return {
    delayMilliseconds: response.delayMilliseconds ?? 0,
    status: response.status ?? 200,
    type: response.type
  };
}

export function createScenarioHttpMock(definition: ScenarioHttpDefinition): ScenarioHttpMock {
  validateDefinition(definition);
  const journal = definition.journal ?? new ScenarioRuntimeJournal(definition.journalPath);
  const callCounts = new Map(definition.routes.map((route) => [route.id, 0]));
  const executionFailures: string[] = [];

  const handlers = definition.routes.map((route) => {
    const method = route.method.toLowerCase() as Lowercase<ScenarioHttpMethod>;
    const handler = method === "all" ? http.all : http[method];
    return handler(route.url, async ({ request, params, cookies }) => {
      const call = (callCounts.get(route.id) ?? 0) + 1;
      callCounts.set(route.id, call);
      journal.record("http.request", await requestDetail(route, request, call));
      const context = createRequestContext(route, request, params, cookies, call);
      try {
        if (route.expectedCalls !== undefined && call > route.expectedCalls) {
          throw new Error(
            `Scenario HTTP route "${route.id}" expected ${route.expectedCalls} call(s), received at least ${call}.`
          );
        }
        await route.assert?.(context);
        const response = await scenarioHttpValue(route.response, context);
        if (response.type !== "networkError") {
          await wait(response.delayMilliseconds ?? 0, request.signal);
        }
        journal.record("http.response", {
          ...responseDetail(response),
          call,
          routeId: route.id
        });
        return createResponse(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (request.signal.aborted) {
          journal.record("http.abort", {
            call,
            error: message,
            routeId: route.id
          });
          return HttpResponse.error();
        }
        executionFailures.push(`"${route.id}": ${message}`);
        journal.record("http.error", {
          call,
          error: message,
          routeId: route.id
        });
        return HttpResponse.error();
      }
    });
  });

  const server: SetupServer = setupServer(...handlers);
  let started = false;

  return {
    journal,
    assertSatisfied(): void {
      const failures = [...executionFailures, ...definition.routes.flatMap((route) => {
        if (route.expectedCalls === undefined) return [];
        const actual = callCounts.get(route.id) ?? 0;
        return actual === route.expectedCalls
          ? []
          : [`"${route.id}" expected ${route.expectedCalls}, received ${actual}`];
      })];
      journal.record("http.assert", { failures });
      if (failures.length > 0) {
        throw new Error(`Scenario HTTP expectations failed: ${failures.join("; ")}`);
      }
    },
    calls(routeId: string): number {
      if (!callCounts.has(routeId)) throw new Error(`Unknown scenario HTTP route: ${routeId}`);
      return callCounts.get(routeId) ?? 0;
    },
    close(): void {
      if (!started) return;
      server.close();
      started = false;
      journal.record("http.close", {});
    },
    start(): void {
      if (started) throw new Error("Scenario HTTP mock is already started.");
      server.listen({
        onUnhandledRequest(request) {
          const detail = { method: request.method, url: request.url };
          executionFailures.push(`unhandled ${request.method} ${request.url}`);
          journal.record("http.unhandled", detail);
          throw new Error(`Unhandled scenario HTTP request: ${request.method} ${request.url}`);
        }
      });
      started = true;
      journal.record("http.start", {
        routes: definition.routes.map((route) => ({
          expectedCalls: route.expectedCalls,
          id: route.id,
          method: route.method,
          url: String(route.url)
        }))
      });
    },
    [Symbol.dispose](): void {
      this.close();
    }
  };
}
