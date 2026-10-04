import { expect, test } from "bun:test";
import { inspectRuntimeConfiguration, writeConfigurationDoctor } from "../src/config-diagnostics.ts";
import { hasRuntimeConfigurationDiagnostics, patchRuntimeConfigurationDiagnostics } from "../scripts/runtime-config-diagnostic-patches.ts";

const env = { HOME: "/fixture-home", USERPROFILE: "/fixture-home" };

test("doctor projects names and sources without exposing MCP configuration values", () => {
  const source = { path: "/fixture-home/.zcode/cli/setting.json", loaded: true, diagnostics: [], mcpServerNames: ["test"] };
  const report = inspectRuntimeConfiguration("/workspace", options => {
    expect(options.workingDirectory).toBe("/workspace");
    return {
      config: { features: { mcp: true }, mcp: { servers: {
        test: { type: "http", url: "https://private.test/?token=secret", headers: { Authorization: "secret" } }
      } } },
      sources: { user: source, project: { ...source, path: undefined, loaded: false, mcpServerNames: [] }, mcp: { serverSources: { test: "user" } } }
    };
  }, env);
  expect(report.ok).toBe(true);
  expect(report.mcp.servers).toEqual([{ name: "test", type: "http", enabled: true, source: "user" }]);
  expect(JSON.stringify(report)).not.toContain("secret");
  expect(JSON.stringify(report)).not.toContain("private.test");
});

test("doctor keeps schema errors useful while suppressing JSON input fragments and terminal controls", () => {
  const report = inspectRuntimeConfiguration("/workspace", () => ({
    config: { features: { mcp: true }, mcp: { servers: {} } },
    sources: {
      user: { path: "/config", loaded: false, mcpServerNames: [], diagnostics: [
        { code: "config_file_invalid", severity: "error", message: 'Unexpected token in JSON: "SECRET_VALUE"', filePath: "/config" }
      ] },
      project: { paths: [], loaded: false, mcpServerNames: [], diagnostics: [
        { code: "config_file_invalid", severity: "error", message: 'ui.theme: Invalid option: expected one of "auto"|"dark"|"light"', filePath: "/project/config.json" },
        { code: "config_mcp_server_invalid", severity: "warning", message: "command: expected string", path: "mcp.servers.bad\u001b[2J", filePath: "/project/config.json" }
      ] },
      mcp: { serverSources: {} }
    }
  }), env);
  expect(report.ok).toBe(false);
  expect(report.user.status).toBe("invalid");
  expect(report.project.paths).toEqual(["/project/config.json"]);
  expect(JSON.stringify(report)).not.toContain("SECRET_VALUE");
  expect(report.diagnostics[1]?.message).toContain("ui.theme");
  let text = "";
  expect(writeConfigurationDoctor({ write(value) { text += value; } }, report)).toBe(1);
  expect(text).toContain("\\u001b");
  expect(text).not.toContain("\u001b");
});

const source = `
var init=once(()=>{label(factory,"createConfig")});
var doctor=label((io,options,cwd)=>{let report={cli:{version:"fixture"},runtime:{cwd},packaging:{default:"node-bundle"}};
if(options.json)return io.stdout.write(JSON.stringify(report)),0;
return io.stdout.write("doctor\\n"),0},"runDoctor");
`;

test("doctor bundle patch preserves metadata, emits one JSON document and returns configuration status", () => {
  const patched = patchRuntimeConfigurationDiagnostics(source);
  expect(hasRuntimeConfigurationDiagnostics(patched)).toBe(true);
  expect(patchRuntimeConfigurationDiagnostics(patched)).toBe(patched);
  let text = "";
  const report = { ok: false };
  const doctor = new Function("require", "__dirname", "once", "label", "factory", `${patched};return doctor;`)(
    (name: string) => name === "node:path" ? { join: (...parts: string[]) => parts.join("/") } : {
      inspectRuntimeConfiguration(cwd: string, createConfig: (options: unknown) => unknown) {
        expect(cwd).toBe("/workspace");
        expect(createConfig({})).toBe("native-config");
        return report;
      },
      writeConfigurationDoctor(output: { write(value: string): void }, value: unknown) {
        expect(value).toBe(report); output.write("config-invalid\n"); return 1;
      }
    }, "/fixture", (fn: () => void) => fn, (fn: unknown) => fn, () => "native-config"
  );
  const io = { stdout: { write(value: string) { text += value; } } };
  expect(doctor(io, { json: true }, "/workspace")).toBe(1);
  expect(JSON.parse(text)).toEqual({ cli: { version: "fixture" }, runtime: { cwd: "/workspace" }, packaging: { default: "node-bundle" }, configuration: report });
  text = "";
  expect(doctor(io, { json: false }, "/workspace")).toBe(1);
  expect(text).toBe("doctor\nconfig-invalid\n");
});

test("doctor patch rejects missing, ambiguous and incomplete upstream boundaries", () => {
  expect(() => patchRuntimeConfigurationDiagnostics(source + source)).toThrow("ambiguous");
  expect(() => patchRuntimeConfigurationDiagnostics(source.replace('"createConfig"', '"changed"'))).toThrow("missing");
  const partial = patchRuntimeConfigurationDiagnostics(source).replace(".writeConfigurationDoctor(", ".changed(");
  expect(hasRuntimeConfigurationDiagnostics(partial)).toBe(false);
  expect(() => patchRuntimeConfigurationDiagnostics(partial)).toThrow("partial");
});
