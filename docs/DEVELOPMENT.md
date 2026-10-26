# Local development

This document covers setting up a development environment for zcode-app-cli.
For installation as an end user, see the [main README](../README.md).

## Prerequisites

Use Bun 1.4.1, the version pinned in `packageManager` and CI, for development
and publishing. Older Bun releases are not part of the validated toolchain.
The CLI and SQLite tests require Node >=22.19.0. `7z` is needed only when
downloading and extracting a remote installer.

## Quick start

Install dependencies, then run the client with live TypeScript and auto-sync
from the local ZCode Desktop installation:

```bash
bun install
bun run dev
```

`bun run dev` runs `sync:local` (rebuild + extract `resources/glm` from
`/Applications/ZCode.app`) and then starts the client through `bun bin/zcode.ts`
with `ZCODE_NODE=node`, so source changes take effect on the next launch
without a manual build step.

## Validation

Runtime TUI projection and background-agent messaging live in
`src/runtime-tui-bridge.ts`; persisted task recovery lives in
`src/runtime-background-restore.ts`. Both compile into the existing
`vendor/cli-config.cjs` helper. Bundle patches capture the active app and delegate
to these functions. Recovery reads optional metadata asynchronously and shares
one in-flight restoration per app, so a concurrent send waits for registration.
The runtime continues to own task lifecycle, registry state and message routing;
the helper merges read models and preserves the existing restore/stop/send order.
`test/runtime-tui-bridge.test.ts` tests these operations directly, while
`test/sync-runtime.test.ts` exercises the injected calls and patch idempotency.

Run all validation layers:

```bash
bun run typecheck
bun run test:all
bun run check
bun run check:tui
```

For a fast feedback loop, use `bun run test:unit`. `test:all` runs the unit,
TUI, runtime and real Node SQLite suites in order; `bun run test:node` runs
the storage layer on its own. Bare `bun test` also discovers the Node-only
tests and is not a substitute for these entry points.

See [TUI scenario testing](./TUI_SCENARIO_TESTING.md) for fixture and PTY
guidance, and [SQLite concurrency](./SQLITE_CONCURRENCY.md) for storage retry
boundaries and real Node regression coverage.

`check:tui` runs real-PTY scenarios. The official runtime scenario completes
masked Coding Plan API-key setup in a temporary home, verifies the official
config output, executes `/help`, switches to plan mode, exits, and checks that
the launcher forwards terminal SIGHUP shutdown. The offline
feature scenario also covers suspended login restoration, selectors, image
attachments, nested Agent tools, Markdown, Mermaid, diffs, transcript
navigation, context/status details, MCP actions, task-scoped background output,
terminal-agent recovery and the
workflow panel. A pressure scenario verifies that steering, UTF-8 input and
Ctrl+C cancellation remain responsive during rapid Bash progress output. The
scenarios advance from observed terminal output instead of fixed timers and do
not make model API calls.

Dependency security fixes and their regression commands are documented in
[`patches/README.md`](../patches/README.md). Source installs must use Bun so
the recorded `sprintf-js` patch is applied.

## pi-tui compatibility

The root package and TUI adapter use pi-tui 1.3.0. Theme detection uses
`queryTerminalColors()` with the scheme-report fallback. Prompt placeholders
and terminal-focus handling recognize pi-tui's fake-cursor APC markers;
the hardware cursor remains the only caret on the focused input. The
`ProcessTerminal` subclass inherits the new `setProgramStatus()` contract.
PTY trace checks share `scripts/terminal-output.ts`, which handles both BEL
and ST control-string terminators without consuming subsequent visible text.

After changing pi-tui, `bun run check:tui` verifies regular/fullscreen input,
focus, search, selection, images and overlays. `bun run verify:tui-perf` runs
the complete quality and performance gate, including those smoke checks.
The three runtime patches
`http-no-content`, `bigmodel-oauth` and `cli-help-contract` also remain in the
patch plan as required verification points: Desktop 3.16.3 already supplies
their behavior, so they report `already_present` and never rewrite the runtime.
Synchronization still fails if a future upstream build drops the behavior.

## Workspace file completion

The required `recursive-workspace-paths` runtime patch extends the native
`createWorkspacePathSuggestionProvider` through `src/runtime-workspace-paths.ts`.
An unqualified `@name` searches all workspace directory levels; empty tokens and
explicit paths retain the native directory completion. Searches use the runtime's
filesystem port and excluded-directory set, skip symlinks, and forward cancellation.
Only the best requested number of matches are retained, with exact names before
prefix and substring matches. Hidden entries require a query beginning with `.`;
this preserves the runtime's existing rules rather than adding `.gitignore` parsing.

`bun test test/runtime-workspace-paths.test.ts test/runtime-workspace-path-patches.test.ts`
covers real file trees and patch compatibility. After syncing the built runtime,
`bun test test/runtime/workspace-paths.test.ts` checks the actual native provider
and filesystem adapter in Node, including the nested file case from #240.

## TUI startup compatibility

Recent upstream runtimes pass session metadata and slash commands through
`loadStartupOptions()` rather than top-level TUI options. The local TUI paints a
cancellable startup screen, calls this loader once, and merges its result before
constructing the editor and session state. Older runtimes that pass top-level
options continue to work. Startup failures propagate after terminal cleanup;
Ctrl+C exits without creating the session UI when the loader finishes later.

Run the isolated startup regression tests and synchronize the built TUI:

```bash
bun test test/tui/startup.test.ts
bun run sync:local # macOS with /Applications/ZCode.app; otherwise use bun run sync:locked
bun scripts/smoke-tui.ts
```

The tests cover lazy and legacy command lists, custom commands, MCP picker
dispatch, cancellation, late rejection, and raw-mode restoration on failure. The
runtime smoke test also checks `/mc` suggestions from the real upstream loader.
For manual verification, launch `zcode`, type `/mc` without submitting, and check
that `mcp` appears. Clear the draft and repeat with `/he` and `/mod`; submitting
`/mcp` should open the configured server picker (or show that none are configured).
Restart the CLI after syncing; an already running process keeps its loaded TUI.

## Reproduce invalid models in resumed sessions (#160)

Build the current CLI, then start an isolated reproduction:

```bash
bun run sync:local # macOS with /Applications/ZCode.app; otherwise use bun run sync:locked
bun scripts/repro-session-model.ts
```

The script creates a real SQLite session, writes the stale model selection from
#160, and resumes it in the real CLI. Model requests go to a local mock server;
no real API key or user configuration is used. Temporary data is removed on exit.

The expected behavior is an immediate **Select a replacement model** dialog.
Choose `zai/glm-5.3`, then send a prompt to receive `SESSION_MODEL_REPLY`.
Cancelling preserves the saved selection and blocks prompts until `/model`
repairs it. A successful switch saves the selection for future resumes and
leaves the shared default unchanged.

Other cases and surfaces:

```bash
bun scripts/repro-session-model.ts --case model-casing --fullscreen
bun scripts/repro-session-model.ts --case missing-model
bun scripts/repro-session-model.ts --case missing-reasoning
bun scripts/repro-session-model.ts --headless
bun test test/runtime/session-model-recovery.test.ts
```

Headless recovery exits with the invalid provider/model and instructions to
resume interactively; it sends no model request. The regression tests also
cover `/resume` inside the TUI and restarting after a repair.

## Runtime refresh regression

`bun test test/runtime-context-cache.test.ts test/tui/runtime-refresh.test.ts`
verifies that text/reasoning deltas do not schedule runtime queries and that
tool activity polling reuses a compact, session-scoped token summary. Completed
requests, history changes and changed projection usage invalidate the summary.
In-flight reads from a previous session or revision cannot overwrite newer
statistics. Full message bodies are read for statistics only after invalidation
or when the user opens `/context`; they are not retained in the cache.

## Context window projection (#212)

`bun test test/runtime-context-window-patches.test.ts test/runtime/context-window-projection.test.ts`
covers the patch that makes the product-state projection report the model's resolved
context window. The runtime assigns `contextWindow` from a `session_created` event
that current runtimes no longer append for new sessions, so `/context`, the runtime
state and the headless `--json` projection kept the 200000 default while compaction
and the request budget used the configured window.
`patchRuntimeResolvedContextWindow` merges the window resolved from the session's
model catalog entry into the reduced event state; models without a declared window
keep the recorded value.

The regression test drives the real runtime with a mock model endpoint: a headless
`--json` run must project the configured 1000000-token window, and `/context` must
render `1M` instead of `200K`.

## OAuth login

The required `shared-oauth` runtime patch keeps Desktop and standalone CLI
credentials compatible. `oauth:zai:access_token` contains the business token
returned by `/api/auth/z/login`, while the OAuth input remains transient.
Standalone account identities come from the active shared profile; explicit
manual API-key connections keep their native identity. Legacy CLI OAuth tokens
are exchanged only after a business HTTP 401, then replaced under the native
credential lock if the stored value still matches. Run
`bun test test/shared-oauth.test.ts test/runtime/shared-oauth.test.ts` after
syncing to cover both login transports, Desktop session reuse and mutation races.

For the OAuth path, run the launcher directly with the login subcommand:

```bash
bun bin/zcode.ts login --oauth
bun run dev
```

To print the authorization URL without launching the browser:

```bash
bun bin/zcode.ts login --oauth --no-browser
```

The URL must still be opened on the same Mac so its `zcode://` callback reaches
the waiting CLI. Cross-device SSH login is not supported by this provider flow;
use the masked Z.AI Coding Plan API-key option instead. The wrapper no longer
uses the upstream `oauth/cli/init` polling endpoint, which currently returns
HTTP 404.

Verify native callback capture and automatic handler restoration without
contacting Z.AI or changing the real `zcode://` association:

```bash
bun run check:oauth-callback
```

## Local command installation

Install a local `zcode` command:

```bash
bun link
zcode
```

Headless and protocol commands use the same inherited stdio path:

```bash
zcode --version
zcode doctor --json
zcode --prompt "Explain this repository"
zcode app-server
zcode plugins list --json
zcode plugins discover --json
```

Marketplace and install commands are launcher-owned adapters over the
runtime's public `app-server` NDJSON methods. Keep protocol framing in
`src/app-server-client.ts` and command parsing in `src/plugin-cli.ts`; do not
add these operations to the minified runtime bridge. The TUI queries
`plugins/referenceCatalog` through the same client and inserts native
`plugin://` links for `@` Plugin completion.

App-server auth selects one credential owner at startup through
`src/app-server-auth.ts`: `standalone` by default, or explicit
`ZCODE_APP_SERVER_AUTH_MODE=host`. The native registry owns credential storage
and refresh; host mode retains the native account-update and request-auth RPCs.
`scripts/runtime-app-server-patches.ts` uses Acorn to parse the exported protocol
agent function, links its registry startup to the ready event and app factory,
and injects registry options plus the registry's auth port. Unrelated functions,
partial patches, mismatched registries and ambiguous anchors cannot satisfy its
verification. Acorn is a synchronization-time development dependency.

Run `bun test test/app-server-auth.test.ts test/runtime-app-server-patches.test.ts`
for mode selection and patch regression tests. After synchronization, run
`bun test test/runtime/app-server-auth.test.ts` for real protocol turns against
a local HTTPS model server: local login, credential rotation, host account
updates and auth callbacks, missing credentials and invalid modes. Tests use
temporary homes, fake credentials and a test-only loopback certificate.

Browser automation is enabled by the launcher only for agent-producing
invocations:

```bash
zcode
zcode --prompt "Inspect https://example.com"
zcode --print "Inspect https://example.com"
zcode --browser-use=headless --browser-executable /path/to/chromium
```

The npm package supplies the runtime-compatible `playwright-core` library but
does not download a browser binary. Keep the executable discovery and launch
logic in the official runtime; use `--browser-executable` for environments
where the system Chrome/Chromium path is non-standard.

Runtime synchronization extracts the strict `parseGlobalArgs` option table into
`vendor/extraction.json`; the launcher consumes that capability manifest rather
than maintaining a duplicate global-option list. Keep command-specific semantic
constraints covered separately: for example, the runtime rejects `--surface`
outside `--prompt`, `--target`, `app-server` and `agent-server` invocations.
The launcher also supplies the runtime's official production `ZCODE_BASE_URL`
when it is absent because bundled plugin MCP templates require an explicit
value; an environment override remains authoritative.

`zcode version`, `zcode --version` and `zcode -v` identify both packaged
layers explicitly:

```text
zcode-app-cli 3.16.3-38
zcode-runtime 0.17.0
```

## OAuth login override

To hand `/login` to another interactive command, set an explicit override:

```bash
export ZCODE_TUI_LOGIN_CMD='zcode login --oauth'
```

The TUI then releases raw terminal mode, runs that command with inherited
stdio, restores the interface, and refreshes the shared provider registry from
`~/.zcode/v2/provider_config.json`.

For the direct API-key path, follow
[Custom provider](./CONFIGURATION.md#custom-provider)
instead.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests, pushes to `main` and manual
dispatches. It validates the project on the minimum supported Node.js 22.19,
including the locked runtime build, TypeScript and unit tests, PTY scenarios,
the reviewed npm tarball and an isolated installed-package smoke test.
The complete runtime suite runs once in that job. Additional Node 24/26 Linux
and Node 24 macOS jobs reuse the same tarball and run `test:runtime:compat`,
the installed-package checks and the real Node SQLite suite. The compatibility
subset covers launch, HTTP streaming/retry, app-server authentication and both
TUI modes; it does not repeat the entire model/configuration/workflow matrix.

`check:tui:focus` uses three representative configurations: regular with
notifications off, fullscreen with unfocused BEL notifications, and the built
fullscreen adapter with notifications off. Backend selection is also covered
by the notification unit tests.

A newer commit to the same pull request or branch automatically cancels its
superseded CI run; unrelated pull requests continue independently.
