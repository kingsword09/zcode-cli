# Local development

This document covers setting up a development environment for zcode-app-cli.
For installation as an end user, see the [main README](../README.md).

## Prerequisites

Developing or publishing from source requires Bun 1.3 or newer. `7z` is needed
only when downloading and extracting a remote installer.

## Initial setup

Install dependencies and extract the already installed macOS application:

```bash
bun install
bun run sync:local
```

## Validation

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
navigation, context/status details, MCP actions, background tasks and the
workflow panel. A pressure scenario verifies that steering, UTF-8 input and
Ctrl+C cancellation remain responsive during rapid Bash progress output. The
scenarios advance from observed terminal output instead of fixed timers and do
not make model API calls.

## Running the client

Start the client directly:

```bash
node bin/zcode.js
```

For the OAuth path:

```bash
node bin/zcode.js login --oauth
node bin/zcode.js
```

To print the authorization URL without launching the browser:

```bash
node bin/zcode.js login --oauth --no-browser
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
```

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
stdio, restores the interface, and checks `~/.zcode/cli/config.json` again.

For the direct API-key path, follow
[Custom provider without login](./CONFIGURATION.md#custom-provider-without-login)
instead.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests, pushes to `main` and manual
dispatches. It validates the project on the minimum supported Node.js 22.19,
including the locked runtime build, TypeScript and unit tests, PTY scenarios,
the reviewed npm tarball and an isolated installed-package smoke test. A newer
commit to the same pull request or branch automatically cancels its superseded
CI run; unrelated pull requests continue independently.
