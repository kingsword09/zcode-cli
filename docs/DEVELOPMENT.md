# Local development

This document covers setting up a development environment for zcode-app-cli.
For installation as an end user, see the [main README](../README.md).

## Prerequisites

Developing or publishing from source requires Bun 1.3 or newer. `7z` is needed
only when downloading and extracting a remote installer.

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
bun test
bun run check
bun run check:tui
```

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

## OAuth login

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
zcode-app-cli 3.3.6-4
zcode-runtime 0.15.2
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
the reviewed npm tarball and an isolated installed-package smoke test. A newer
commit to the same pull request or branch automatically cancels its superseded
CI run; unrelated pull requests continue independently.
