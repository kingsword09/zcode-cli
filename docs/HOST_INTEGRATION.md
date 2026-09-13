# Host integration contract

This document defines the supported boundary between `zcode-app-cli` and a
terminal host or agent orchestrator. It is versioned independently from the
internal runtime implementation so hosts can integrate with the CLI without
depending on private files under `vendor/`.

**Contract version: 1**

## Supported entry point

Hosts should start the published `zcode` executable and pass user arguments
through unchanged:

```text
zcode [arguments...]
```

The public entry point is the `zcode` npm bin exposed by `bin/zcode.js`. Hosts
must not invoke `vendor/zcode.cjs`, `vendor/extraction.json`, or other package
internals directly. Those files are implementation details and may change
between releases.

The launcher is a process boundary, not a library API. A host should be able
to replace the CLI package without changing its own process model.

## Terminal and standard streams

- For an interactive TUI invocation, allocate one terminal/PTY for the
  `zcode` process and inherit its stdin and stdout. The launcher may capture
  runtime stderr into its bounded diagnostic log, so hosts must not depend on
  raw TUI stderr text being visible in the terminal.
- Do not insert a second PTY, relay terminal bytes through a second renderer,
  or parse ANSI screen output as an integration protocol.
- For non-interactive commands, preserve the inherited standard-stream
  contract; the command's documented output is the only supported machine
  interface.
- Set the child's working directory to the workspace the user selected. The
  launcher passes it to the runtime.

Example from a Node host:

```js
import { spawn } from "node:child_process";

const child = spawn("zcode", ["--cwd", workspace, ...args], {
  cwd: workspace,
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  // Preserve the CLI result in the host's run record.
  console.log({ code, signal });
});
```

## Signals and exit status

The launcher forwards `SIGINT`, `SIGTERM`, and (on Unix) `SIGHUP` to the
runtime child. Hosts should send those signals to the `zcode` process when a
run is cancelled or its terminal is closed, then wait for the process to exit.

The launcher returns the runtime's exit code. If the runtime exits because of a
signal, the launcher uses the conventional `128 + signal number` status. A
host should record the final status rather than treating any non-zero result as
a transport failure.

## Environment and configuration

The following variables are supported host integration points:

| Variable | Purpose |
| --- | --- |
| `ZCODE_NODE` | Override the Node.js executable used to run the bundled runtime. |
| `ZCODE_BASE_URL` | Override the official ZCode service base URL. |
| `ZCODE_MODEL_RETRY_MAX_RETRIES` | Override the model retry limit. |
| `ZCODE_TUI_RUNTIME_LOG` | Choose the bounded diagnostic log for TUI runtime stderr. |

Hosts should pass user configuration through the normal ZCode environment and
configuration files. Do not put API keys or other secrets in command-line
arguments or host logs.

The launcher does not install, replace, or select a different npm package
while a command is running. A host that needs reproducible deployments should
pin the published `zcode-app-cli` version in its own installation workflow.
Multi-version retention and rollback are host policy, not part of the `zcode`
process contract.

## Version identity

`zcode version`, `zcode --version`, and `zcode -v` report both layers:

```text
zcode-app-cli <distribution-version>
zcode-runtime <runtime-version>
```

Hosts may display this output or store it with a run record. They should not
infer capabilities from the TUI banner or from private runtime file names.

## Host responsibilities

The host owns:

1. installing a published package version;
2. selecting the workspace and environment;
3. allocating the terminal when interactive mode is requested;
4. forwarding cancellation and terminal-close signals;
5. capturing the exit status and any host-level logs; and
6. applying its own update, retention, and rollback policy.

The CLI owns terminal interaction, model access, sessions, tools, plugins,
skills, and the runtime-specific command semantics. Hosts should use the
documented command line and stdio boundary instead of importing internal
TypeScript modules.

## Compatibility rules

- A host may support any release that exposes the `zcode` npm bin and this
  contract version.
- Internal TUI layout, runtime bundle paths, and extracted symbol names are not
  compatibility surfaces.
- Host-specific branding belongs in the host integration, not in the upstream
  runtime package.
- If a host needs a new machine-readable capability, it should propose a
  documented CLI output or a new contract version rather than scraping the
  interactive screen.

Herdr, Orca, and other terminal orchestrators can therefore share the same
`zcode` process contract while keeping their own installation and lifecycle
policies outside the CLI implementation.
