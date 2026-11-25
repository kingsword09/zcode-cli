import { parseExpressionAt, type FunctionExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";

function unique<T>(values: T[], anchor: string): T {
  if (values.length !== 1) throw new Error(`ZCode runtime is missing native OAuth polling support (${anchor}).`);
  return values[0]!;
}

function symbol(runtime: string, label: string): string {
  return unique(
    [...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))],
    label
  )[1]!;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namedFunction(runtime: string, label: string): FunctionExpression {
  const name = symbol(runtime, label);
  const match = unique(
    [...runtime.matchAll(new RegExp(`(?:async )?function ${name}\\(`, "gu"))],
    `${label} function`
  );
  const fn = parseExpressionAt(runtime, match.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.id?.name !== name) {
    throw new Error(`ZCode runtime changed the native ${label} function.`);
  }
  return fn;
}

/** Verify the Z.AI and BigModel OAuth polling flow implemented by the pinned runtime. */
export function hasRuntimeNativePollingOAuth(runtime: string): boolean {
  try {
    const login = namedFunction(runtime, "loginZCodeCli");
    const wrapper = namedFunction(runtime, "loginBigmodelCodingPlan");
    const polling = symbol(runtime, "pollUntilReady");
    const body = runtime.slice(login.body.start + 1, login.body.end - 1);
    const delegation = runtime.slice(wrapper.body.start + 1, wrapper.body.end - 1);
    return new RegExp(`${escape(login.id!.name)}\\(\\{\\.\\.\.${identifier},providerId:"bigmodel"\\}\\)`, "u").test(delegation)
      && body.includes(`${polling}({`)
      && body.includes('authSource:"oauth"')
      && /\[([A-Za-z_$][\w$]*)\.zcodeJwtToken\]:([A-Za-z_$][\w$]*)\.token,\[\1\.bigmodelAccessToken\]:\2\.accessToken,/u.test(body);
  } catch {
    return false;
  }
}
