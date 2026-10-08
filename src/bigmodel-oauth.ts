interface OAuthHttpClient {
  request(options: {
    body: Uint8Array;
    headers: Record<string, string>;
    maxResponseBytes: number;
    method: "POST";
    trace?: unknown;
    url: string;
  }, signal?: AbortSignal): Promise<{ status: number; body: Uint8Array }>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Match Desktop's BigModelProviderAdapter: the official server owns the app secret. */
export async function exchangeBigmodelOAuthCode(options: {
  code: string;
  redirectUri: string;
  state: string;
  httpClient: OAuthHttpClient;
  abortSignal?: AbortSignal;
  trace?: unknown;
}): Promise<{ accessToken: string; refreshToken?: string; zcodeJwtToken: string }> {
  options.abortSignal?.throwIfAborted();
  if (!nonempty(options.code) || !nonempty(options.redirectUri) || !nonempty(options.state)) {
    throw new Error("BigModel OAuth requires an authorization code, redirect URI and state.");
  }
  const response = await options.httpClient.request({
    body: new TextEncoder().encode(JSON.stringify({
      provider: "bigmodel", code: options.code, redirect_uri: options.redirectUri, state: options.state
    })),
    headers: { "Content-Type": "application/json" },
    maxResponseBytes: 65_536,
    method: "POST",
    trace: options.trace,
    url: "https://zcode.z.ai/api/v1/oauth/token"
  }, options.abortSignal);
  let envelope: Record<string, unknown>;
  try {
    envelope = record(JSON.parse(new TextDecoder().decode(response.body)));
  } catch {
    throw new Error(`BigModel OAuth HTTP ${response.status}: token response is not valid JSON.`);
  }
  const message = nonempty(envelope.msg);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`BigModel OAuth HTTP ${response.status}${message ? `: ${message}` : "."}`);
  }
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new Error(`BigModel OAuth token exchange failed${message ? `: ${message}` : "."}`);
  }
  const data = record(envelope.data), bigmodel = record(data.bigmodel);
  const zcodeJwtToken = nonempty(data.token);
  const accessToken = nonempty(bigmodel.access_token) ?? nonempty(bigmodel.accessToken)
    ?? nonempty(data.access_token) ?? nonempty(data.accessToken);
  if (!zcodeJwtToken) throw new Error("BigModel OAuth token response is missing data.token.");
  if (!accessToken) throw new Error("BigModel OAuth token response is missing data.bigmodel.access_token.");
  const refreshToken = nonempty(bigmodel.refresh_token) ?? nonempty(bigmodel.refreshToken);
  return { accessToken, zcodeJwtToken, ...(refreshToken ? { refreshToken } : {}) };
}
