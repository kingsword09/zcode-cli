# zcode-app-cli

Unofficial terminal client for the official agent runtime shipped with ZCode Desktop.

The project extracts the upstream `resources/glm` runtime, injects a local
`@zcode/tui` implementation based on
[`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui),
and starts it through Bun's native `Bun.Terminal` PTY API.

This project is not affiliated with or endorsed by Z.ai. ZCode and its bundled
runtime remain subject to their upstream terms. Confirm that you are allowed to
redistribute the extracted runtime before publishing the npm package.

## Architecture

```text
Bun launcher
  └─ Bun.Terminal (PTY / resize / input forwarding)
      └─ Node.js
          └─ official zcode.cjs agent runtime
              └─ local @zcode/tui adapter
                  └─ @earendil-works/pi-tui
```

The official agent, model, session, tool, plugin, MCP, credential store and
provider-configuration logic remains in the extracted runtime. The local
package supplies the missing terminal interface and a narrow macOS callback
bridge for Z.AI's registered Desktop OAuth flow.

Node.js remains necessary because ZCode CLI 0.15.x imports `node:sea`, which Bun
does not currently implement. Bun owns the outer CLI and native terminal; Node
is the compatibility host for the extracted upstream kernel. Synchronization
adds the local TUI/data bridge, OAuth compatibility handoff and clearer HTTP
diagnostics. OAuth callbacks are passed to the official runtime over stdin; its
encrypted credential store, Coding Plan key resolver and config writer remain
the only persistence path.

## Current TUI functionality

- pi-tui differential rendering and CJK-aware multi-line editor;
- streamed assistant text from official ZCode session events;
- slash-command and workspace-path completion;
- persisted prompt history through ZCode's history API;
- `/mode`, `/model`, `/resume`, `/plugins` and other upstream slash commands;
- searchable model and reasoning-effort selectors, plus MCP and workflow panels;
- status-bar-only Shift+Tab mode, Ctrl+N model, Ctrl+L autonomy and empty-prompt Tab effort cycling;
- structured session-goal status in the right side of the turn footer;
- responsive context-remaining and session-token metrics in the status line;
- generic upstream selection dialogs for sessions, plugins and checkpoints;
- `/login` setup choices with masked API-key entry, redacted transcript/history and OAuth waiting state;
- suspended Z.AI browser login with terminal restoration and an optional `ZCODE_TUI_LOGIN_CMD` override;
- interactive tool-permission approval dialogs;
- clipboard image attachments through Ctrl+V or `/paste-image`;
- compact tool execution views with path, command, progress, result and image previews;
- parent/child Agent tool trees with resumable subagent metadata and expandable Prompt/Response details;
- syntax-highlighted Markdown code blocks with stable streaming-block rendering;
- Pierre-style inline diffs with line numbers, syntax highlighting, word-level changes and CJK wrapping;
- `/diff` browser for current Git changes and per-turn file changes, including paged details and binary/untracked states;
- terminal-native Mermaid previews with source fallback for unsupported or oversized diagrams;
- `/context` prompt-composition, cache and context-usage details;
- `/status` session, runtime, goal, MCP and workspace details;
- searchable transcript navigation with per-block expansion, selected-block copying and `n`/`N` match traversal;
- persistent active-tool, background-task and open-plan activity between the transcript and editor;
- active-turn steering, cancellation and error reporting;
- `/copy`, `/clear`, `/exit`, Ctrl+C and Ctrl+D handling with token usage and resume guidance on exit;
- `--no-color` and `NO_COLOR` support.

### Referencing workspace files

Type `@` at the start of the prompt or after whitespace to open project file
completion. Continue typing a path, use Up/Down to choose a candidate, then
press Tab or Enter to insert it. Selecting a directory lets you continue with
the next path segment.

```text
Explain @README.md
Compare @src/index.ts with @"docs/design notes.md"
```

Suggestions come from the official ZCode runtime, stay inside the current
workspace and exclude common repository metadata and dependency directories.
Paths containing spaces are inserted in the quoted `@"..."` form.

### TUI inspection and navigation

```text
/diff                         browse current and per-turn file changes
/context                      inspect context usage and source composition
/status                       inspect detailed runtime and session status
/tasks                        inspect or stop background tasks
/search <text>                search retained transcript blocks
/search next|prev|clear       navigate or close transcript search
/transcript latest            select the latest transcript block
/transcript next|prev|close   navigate or leave transcript selection
/copy                         copy the selected block, or the latest response
```

While the editor is empty, `Alt+Up` and `Alt+Down` navigate selected transcript
blocks. `Ctrl+O` expands only the selected/search-matched block; without a
selection it toggles all expandable content. During transcript search, `n` and
`N` move to the next and previous match. `PageUp` and `PageDown` page through
an oversized selected block without rendering the entire message at once.
`Esc` leaves search or transcript navigation.

## Requirements

- Bun 1.3 or newer;
- Node.js 22.19 or newer;
- macOS, Linux or Windows for `Bun.Terminal`;
- `7z` when downloading and extracting a remote installer.

Z.AI browser OAuth currently requires macOS because the registered provider
callback is `zcode://zai-auth/callback`; API-key and custom-provider access work
on every supported platform.

Set `ZCODE_NODE=/absolute/path/to/node` when the desired Node.js executable is
not available on `PATH`.

## Model access and configuration

On first launch, ZCode recursively creates the configuration directory and a
credential-free `config.json` when it is missing. Existing files are never
replaced. The location is `~/.zcode/cli/config.json` on macOS and Linux, and
`%USERPROFILE%\.zcode\cli\config.json` on Windows. Newly created directories
and files use private permissions on POSIX; Windows keeps the current user's
inherited ACLs.

The generated file contains the complete non-secret configuration shape plus
valid Z.AI model metadata, but deliberately omits `apiKey` until one is
configured. This lets the official runtime and TUI start cleanly without
pretending that model access is already configured. Choose one of these
model-access paths before sending a prompt:

- Z.AI OAuth on macOS: run `zcode login` when no provider is configured, or
  `zcode login --oauth` to force reauthorization;
- Z.AI/BigModel Coding Plan API key: open `/login` in the TUI and choose the
  matching masked API-key option;
- direct API key with a custom provider: use the
  [`config.example.json`](./config.example.json) template and do not log in.

When `model.main` already resolves to a configured provider/model with an
inline API key, plain `zcode login` exits successfully and explains that OAuth
is unnecessary. This prevents a custom provider from being replaced by an
unrelated login flow.

### Coding Plan API key

Start the TUI and open its setup picker:

```text
/login
```

Choose either **Z.AI Coding Plan API Key** or **BigModel Coding Plan API Key**,
then paste the key into the masked prompt. The raw key is sent only to the
official runtime's `configureCodingPlanApiKey` implementation. The local TUI
does not add it to editor history or the visible/session transcript, and error
messages are redacted before rendering.

The same picker includes a **Custom provider** entry that points to the
configuration-template path below. Custom providers do not use OAuth.

Selecting **Z.AI Coding Plan** releases TUI raw mode and starts the registered
Desktop authorization-code flow. On macOS the CLI temporarily installs a
background-only callback receiver, verifies the returned `state`, restores the
previous `zcode://` handler, and hands the callback to the official runtime.
The authorization code travels over stdin instead of command-line arguments or
environment variables. The runtime performs token exchange, encrypted
credential persistence, Coding Plan API-key resolution and `config.json`
updates. The TUI is then restored and the model configuration is re-read.

The callback receiver is removed after success, cancellation or timeout. A
small recovery record lets the next login restore the previous handler after
an unclean process exit. The BigModel option continues to use the official
localhost-callback implementation inside the runtime.

### Custom provider without login

Start `zcode` once to generate the full user configuration automatically. From
a source checkout, `config.example.json` contains the same initial structure
for reference. Then edit the generated file:

```bash
zcode
```

Edit these four areas in `~/.zcode/cli/config.json` (or the Windows path shown
above):

1. `provider.zai.kind`: use `anthropic`, `openai-compatible`, or `openai`;
2. `provider.zai.options.baseURL`: use the provider's API root;
3. `provider.zai.options.apiKey`: insert the direct API key;
4. replace the entries in `provider.zai.models`, then point both `model.main`
   and `model.lite` at the desired model IDs.

The provider map key is deliberately `zai`. The upstream CLI 0.15.x TUI
considers a direct API key configured only when it is stored under provider ID
`zai` or `bigmodel`. An arbitrary provider ID is valid model configuration,
but as the only provider it still triggers the upstream login gate. The
display name, API format, endpoint, headers and models remain fully custom.

For an Anthropic-compatible endpoint:

```json
{
  "kind": "anthropic",
  "options": {
    "baseURL": "https://example.com/api/anthropic",
    "apiKey": "YOUR_API_KEY",
    "apiKeyRequired": true
  }
}
```

Use the API root, not a final `/messages` path. For an OpenAI-compatible
endpoint, set `kind` to `openai-compatible` and normally use a root ending in
`/v1`, not `/chat/completions`. For the official OpenAI API, use `openai`;
`baseURL` can be omitted.

The object keys form the runtime model reference:

```text
provider.<provider-id>.models.<model-id>
                    -> <provider-id>/<model-id>
```

Set both roles to keep all work on the custom provider:

```json
{
  "model": {
    "main": "zai/your-model-id",
    "lite": "zai/your-model-id"
  }
}
```

`main` is the normal conversation model. `lite` is used for lightweight and
subagent work. Model IDs are case-sensitive and must match the endpoint.

The no-login TUI path currently requires a non-empty `options.apiKey` in the
local config; an environment-only API key does not satisfy the upstream login
gate. Never commit the populated file, and keep its mode at `600`.

### Use the custom provider

After saving the config, no login command is required. Start the client:

```bash
bun bin/zcode.ts
```

Or, after `bun link` or an npm installation:

```bash
zcode
```

Use these commands inside the TUI:

```text
/model                         # show the active and available models
/model zai/your-model-id       # switch to the custom provider explicitly
/new                           # start a new session with the configured default
```

The status line should show `zai/your-model-id`. Setting both `model.main` and
`model.lite` in the config makes the custom provider the default for normal,
lightweight and subagent work. A resumed session may retain its previous model,
so use `/new` after changing the default.

Headless prompts use the same provider configuration:

```bash
zcode --prompt "Explain this repository"
```

`ZCODE_MODEL`, `zcode.json`, or `.zcode/config.json` can override the
user-level default. Running `/model` does not call the provider, so it is a safe
configuration check before the first prompt.

## Local development

Install dependencies and extract the already installed macOS application:

```bash
bun install
bun run sync:local
```

Run all validation layers:

```bash
bun run typecheck
bun test
bun run check
bun run check:tui
```

`check:tui` runs two real-PTY scenarios. The official runtime scenario completes
masked Coding Plan API-key setup in a temporary home, verifies the official
config output, executes `/help`, switches to plan mode, and exits. The offline
feature scenario also covers suspended login restoration, selectors, image
attachments, nested Agent tools, Markdown, Mermaid, diffs, transcript
navigation, context/status details, MCP actions, background tasks and the
workflow panel. Both scenarios advance from observed terminal output instead
of fixed timers and do not make model API calls.

Start the client directly:

```bash
bun bin/zcode.ts
```

For the OAuth path:

```bash
bun bin/zcode.ts login --oauth
bun bin/zcode.ts
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

To hand `/login` to another interactive command, set an explicit override:

```bash
export ZCODE_TUI_LOGIN_CMD='zcode login --oauth'
```

The TUI then releases raw terminal mode, runs that command with inherited
stdio, restores the interface, and checks `~/.zcode/cli/config.json` again.

For the direct API-key path, follow
[Custom provider without login](#custom-provider-without-login) instead.

Install a local `zcode` command:

```bash
bun link
zcode
```

Headless and protocol commands bypass the PTY and preserve ordinary stdio:

```bash
zcode --version
zcode doctor --json
zcode --prompt "Explain this repository"
zcode app-server
```

## Remote extraction

The same path used by CI can be run locally:

```bash
brew install sevenzip
bun run sync -- --platform linux --arch x64
```

The synchronization command:

1. reads the official updater manifest;
2. downloads the matching installer;
3. verifies its SHA-512 from the manifest;
4. extracts `resources/glm`;
5. builds and injects the local `@zcode/tui` adapter;
6. validates the official CLI version;
7. records provenance in `vendor/extraction.json`;
8. updates the npm package version to the ZCode App version.

## Automated npm publishing

`.github/workflows/sync-and-publish.yml` runs every day at 02:23 UTC and can
also be started manually. It uses Bun for installation, building, tests,
TypeScript 7 checking, extraction and PTY validation. npm is used only for the
final provenance-enabled registry publication.

Before enabling publication:

1. confirm that `zcode-app-cli` is the npm package name you control;
2. confirm redistribution rights for the extracted ZCode runtime;
3. add an npm automation token as the `NPM_TOKEN` GitHub Actions secret, or
   configure npm trusted publishing;
4. run the workflow manually once.

The workflow skips publication when the extracted App version already exists
on npm.
