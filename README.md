# zcode-app-cli

Unofficial terminal client for the official agent runtime shipped with ZCode Desktop.

The project extracts the upstream `resources/glm` runtime, injects a local
`@zcode/tui` implementation based on
[`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/main/packages/tui),
and launches it as a Node.js child process that directly inherits the user's
terminal.

This project is not affiliated with or endorsed by Z.ai. ZCode and its bundled
runtime remain subject to their upstream terms. Confirm that you are allowed to
redistribute the extracted runtime before publishing the npm package.

## Install and update

Install or update the CLI through the `latest` dist-tag:

```bash
npm install -g zcode-app-cli@latest
# or
bun add -g zcode-app-cli@latest
```

Using `@latest` is intentional because the App-aligned release format uses a
SemVer prerelease segment such as `3.3.5-2`. The tag always points to the
newest validated App-plus-build release.

Interactive startup checks the npm `latest` tag at most once every 20 hours.
A cached newer version is shown as a non-blocking update card with the exact
install command and release-notes link. Missing or stale cache data is refreshed
in the background for the next launch, so registry latency or failure never
delays the editor. Set `ZCODE_DISABLE_UPDATE_CHECK=1` or
`NO_UPDATE_NOTIFIER=1` to disable the check; CI environments skip it
automatically.

A normal installation requires only Node.js and has no native PTY addon or
postinstall build step.

## Architecture

```text
Node.js npm launcher (config / login / version metadata)
  └─ inherited stdin / stdout / stderr
      └─ official zcode.cjs agent runtime
          └─ local @zcode/tui adapter
              └─ @earendil-works/pi-tui
```

The official agent, model, session, tool, plugin, MCP, credential store and
provider-configuration logic remains in the extracted runtime. The local
package supplies the missing terminal interface and a narrow macOS callback
bridge for Z.AI's registered Desktop OAuth flow.

Node.js starts the public npm command and remains the compatibility host for the
extracted upstream kernel. The official runtime directly owns raw terminal mode,
IME cursor placement and resize handling; the launcher does not insert a second
PTY or relay terminal bytes. Synchronization adds the local TUI/data bridge,
OAuth compatibility handoff and clearer HTTP diagnostics. OAuth callbacks are
passed to the official runtime over stdin; its encrypted credential store,
Coding Plan key resolver and config writer remain the only persistence path.

## Current TUI functionality

- pi-tui differential rendering and CJK-aware multi-line editor;
- streamed assistant text from official ZCode session events;
- slash-command and workspace-path completion;
- persisted prompt history through ZCode's history API;
- `/mode`, `/model`, `/resume`, `/plugins` and other upstream slash commands;
- searchable model and reasoning-effort selectors, plus MCP and workflow panels;
- status-bar-only Shift+Tab mode (`build` → `edit` → `yolo` → `plan`), Ctrl+N model and empty-prompt Tab effort cycling;
- structured session-goal status in the right side of the turn footer;
- animated active-turn timer with a static `ZCODE_TUI_REDUCED_MOTION=1` fallback;
- responsive context-remaining and session-token metrics in the status line;
- generic upstream selection dialogs for sessions, plugins and checkpoints;
- `/login` setup choices with masked API-key entry, redacted transcript/history and OAuth waiting state;
- suspended Z.AI browser login with terminal restoration and an optional `ZCODE_TUI_LOGIN_CMD` override;
- interactive tool-permission approval dialogs;
- clipboard image attachments through Ctrl+V or `/paste-image`, with a keyboard-selectable attachment row;
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
- unfocused turn-completion notifications through terminal-native OSC 9 or BEL, with optional desktop commands;
- double-Esc rewind with input-point selection and safe conversation/workspace scopes;
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

### Active-turn input

While a regular agent turn is running, press `Enter` to send the current text
as same-turn steering. Until the official runtime reaches a safe model-step
boundary, the steer stays in a waiting row next to the editor instead of being
shown as committed conversation history. Once the runtime confirms injection,
the message moves into the transcript at its actual position and uses the normal
user-message `›` prefix. The `↪` marker is reserved for the temporary waiting
row.

To keep a follow-up editable instead, press `Tab` while the editor contains
text and completion is closed. The input remains in the local next-turn queue.
Queued inputs start in FIFO order after the active turn completes normally.
With an empty editor, press `Alt+Up` or `Shift+Left` to move the most recently
queued input back into the editor. Accepted steers cannot be edited because
they have already been handed to the official runtime, even while the waiting
row is visible; use `Tab` when the text must remain changeable. A steer rejected
or discarded before injection returns to the editable next-turn queue.

### Image attachments

Press `Ctrl+V` or run `/paste-image` to attach an image from the clipboard.
Pending images appear above the editor as complete `[Image #N]` tokens.
Submitting a prompt moves those images into that user turn immediately, so they
are removed from the pending row and cannot leak into the next prompt.

Move the editor cursor to the start of its first line and press `Up`, or run
`/attachments`, to focus the attachment row. While it is focused:

- `Left`/`Right` selects an image;
- `Backspace` or `Delete` removes the selected image and renumbers the rest;
- `Down`, `Esc`, `Ctrl+C`, or `Enter` returns to the editor without changing its text.

Run `/attachments clear` to remove every pending image at once. `Ctrl+D`
retains its terminal-standard empty-editor exit and forward-delete behavior.

### Turn completion notifications

Notifications are enabled by default and emitted after a normal agent turn
completes or fails while the terminal is unfocused. Following Codex's terminal
capability fallback, `auto` uses OSC 9 in Ghostty, iTerm2, Kitty, Warp and
WezTerm, and BEL in terminals such as Apple Terminal. Selecting OSC 9 in an
unsupported terminal also falls back to BEL instead of silently emitting an
ignored sequence.

The `unfocused` condition uses DEC focus reporting when the terminal provides
it. Until focus support is confirmed, ZCode sends the notification instead of
permanently suppressing it as focused. `native` is an explicit opt-in that uses
an existing system command: `terminal-notifier` on macOS, `notify-send` on
Linux, or `SnoreToast` on Windows. These tools are not bundled, keeping the
default terminal notification path dependency-free. If the selected command is
unavailable or delivery fails, ZCode falls back to BEL. On macOS, the detected
terminal application is used as both the sender and click target. Exact tab or
pane restoration remains terminal-dependent; use the default `auto` setting so
OSC-capable terminals can preserve their native session behavior.

Open the interactive settings picker inside the TUI (both commands are
equivalent):

```text
/config
/settings
```

Saving a value returns to the settings root so several options can be changed
in one visit. `Esc` returns from a setting to the root, then closes the root.

The picker updates the active session immediately and persists the selected
values under `ui.notifications` in the cross-platform user `config.json`:

```json
{
  "ui": {
    "notifications": {
      "method": "auto",
      "condition": "unfocused"
    }
  }
}
```

Environment variables override `config.json` on startup and are useful for a
temporary per-shell setting:

```bash
export ZCODE_TUI_NOTIFICATION_METHOD=auto       # auto|osc9|bel|native|off
export ZCODE_TUI_NOTIFICATION_CONDITION=always  # unfocused|always
node bin/zcode.js
```

### Conversation rewind

With an empty editor and no active turn, press `Esc` twice within 800 ms to
open the conversation rewind picker. Choose the user input to return to, review
the available workspace checkpoints, then select one of the available scopes:

- **Conversation only** removes later conversation turns, keeps workspace
  files unchanged, and restores the selected input to the editor;
- **Conversation and workspace** also restores safe checkpointed file changes;
- **Workspace only** restores safe checkpointed files without changing the
  conversation.

The scope picker only offers workspace restoration when the official ZCode
runtime reports a complete safe checkpoint plan. Files changed externally are
not overwritten, and Bash or terminal file mutations are reported as ignored
because they do not have restorable ZCode checkpoints. Press `Esc` in the scope
picker to return to input selection, then `Esc` again to close rewind.

### TUI inspection and navigation

```text
/diff                         browse current and per-turn file changes
/context                      inspect context usage and source composition
/status                       inspect detailed runtime and session status
/activity                     inspect every active tool and open task
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

- Node.js 22.19 or newer;
- macOS, Linux or Windows on x64 or ARM64.

Developing or publishing from source additionally requires Bun 1.3 or newer.
`7z` is needed only when downloading and extracting a remote installer.

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

Set `ui.theme` to `"auto"` (terminal detection), `"dark"`, or `"light"`.
An explicit dark/light value takes priority over terminal probing.

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
node bin/zcode.js
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

### Request retries and stalled streams

The CLI leaves retry classification and execution to the official ZCode
runtime. It supplies a default retry budget of five retries; override it when
needed with the runtime's own environment variable:

```bash
ZCODE_MODEL_RETRY_MAX_RETRIES=3 zcode
```

Newly generated configs use a 60-second model-stream idle timeout:

```json
{
  "modelStream": {
    "idleTimeoutMs": 60000
  }
}
```

Existing configs are never overwritten, so update this field manually if an
older generated file still contains `600000`. Retryable timeouts, dropped
streams, rate limits and server/network errors are retried and shown in the
TUI. Authentication and invalid-request responses remain non-retryable.

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

### Continuous integration

`.github/workflows/ci.yml` runs for pull requests, pushes to `main` and manual
dispatches. It validates the project on the minimum supported Node.js 22.19,
including the locked runtime build, TypeScript and unit tests, PTY scenarios,
the reviewed npm tarball and an isolated installed-package smoke test. A newer
commit to the same pull request or branch automatically cancels its superseded
CI run; unrelated pull requests continue independently.

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

Headless and protocol commands use the same inherited stdio path:

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

Use the committed artifact instead of the latest updater manifest when
rebuilding a reviewed release:

```bash
bun run sync:locked
```

The synchronization command:

1. reads the official updater manifest;
2. downloads the matching installer;
3. verifies its SHA-512 from the manifest;
4. extracts `resources/glm`;
5. builds and injects the local `@zcode/tui` adapter;
6. validates the official CLI version;
7. records provenance in `vendor/extraction.json`;
8. records the remote artifact URL and SHA-512 in
   `zcode-runtime.lock.json`;
9. aligns the npm version prefix with the ZCode App version while preserving
   the independently incremented CLI build revision.

## npm package contents

The published package is controlled by the `files` allowlist in `package.json`.
It contains only:

- `bin/zcode.js`, the bundled executable Node.js launcher;
- `vendor/`, the verified official `zcode.cjs` runtime, official bundled
  plugins and the compiled local `@zcode/tui` adapter;
- `config.example.json` and `zcode-runtime.lock.json`;
- `README.md`, `LICENSE` and the required npm `package.json`.

Tests, GitHub workflows, build scripts, launcher/TUI TypeScript sources, local
config, `.release/` artifacts and development `node_modules` are not published.
npm installs only the declared pi-tui runtime dependency. The launcher and TUI
are compiled to JavaScript with `tsdown`; its launcher banner adds the Node.js
shebang directly, with no post-build rewrite. The compiled TUI is injected into
`vendor/` before publication.

## Automated npm publishing

Package versions use `<app-version>-<build>`, for example `3.3.5-2`. The prefix
tracks the upstream ZCode App. The globally increasing build revision tracks
fixes and features in this project. Do not use `3.3.5+build.2`: SemVer ignores
`+build` metadata when comparing upgrades.

Increment the project revision before publishing a local fix or feature:

```bash
bun run version:build
```

The release workflows normally perform that increment for you. The command is
also available for local inspection and exceptional manual preparation.

### Release flow

Publishing is split into two workflows so the committed version, npm package,
Git tag and GitHub Release all describe the same release:

1. `.github/workflows/prepare-release.yml` extracts and validates the current
   official runtime, then opens or updates a Release PR containing the exact
   `package.json` version and `zcode-runtime.lock.json` build input;
2. a maintainer reviews and merges that PR;
3. `.github/workflows/publish.yml` checks out its merge commit, rebuilds the
   exact locked runtime, audits and install-tests the tarball, publishes through
   npm Trusted Publishing, then creates `v<version>` and the corresponding
   GitHub Release.

The generated `vendor/` directory remains ignored by Git and is rebuilt in both
workflows. Its updater URL and SHA-512 are committed in
`zcode-runtime.lock.json`. Preparation resolves the latest manifest; publishing
downloads the committed URL and verifies the locked SHA-512, so a later upstream
update cannot silently change a reviewed release.

The preparation workflow runs every day at 02:23 UTC in `upstream` mode. It
creates a PR when the ZCode App version or the pinned installer changes. A
same-version upstream repack increments the global build so npm still receives
an immutable new version. From the Actions page, run **Prepare ZCode CLI
release** with one of these modes:

- `cli` increments the global build and also aligns with the latest App;
- `upstream` checks for an App update without incrementing the build.

The modes use `release/zcode-cli` and `release/zcode-upstream` respectively. If
both PRs are open, merge one and rerun the other preparation mode so its version
is recalculated from the new `main` branch.

Merging either Release PR publishes automatically. **Publish ZCode CLI
release** can also be started manually for recovery. Its `publish` checkbox can
be disabled to run all validation and consistency checks without changing npm,
Git tags or GitHub Releases. Publication, tag creation and GitHub Release
creation are independently idempotent, so a partially completed run can be
retried safely.

### Local release build

Local packaging uses the same commands as the publishing workflow. Start from
the exact clean commit whose version will be published:

```bash
bun install --frozen-lockfile
bun run release:build
git diff --exit-code -- package.json zcode-runtime.lock.json
bun run release:pack
```

`release:build` runs TypeScript checking and all tests, downloads the artifact
from `zcode-runtime.lock.json`, verifies its SHA-512, builds and injects the TUI,
then runs runtime and PTY smoke tests. `release:pack` runs the offline
`prepack` guard, creates `.release/zcode-app-cli-<version>.tgz`, audits every
included path and executable mode, installs it into a temporary directory, and
runs the installed `zcode --version`. Its final size, integrity and file count
are written to `.release/release.json`.

Inspect that manifest and then publish explicitly:

```bash
npm login
npm publish --access public --tag latest --provenance=false
```

The final `npm publish` intentionally remains explicit to avoid an accidental
registry mutation. It reruns the same offline `prepack` guard and fails if the
compiled TUI, runtime provenance, lock file, launcher permissions or package
allowlist are stale. `--provenance=false` applies only to this local bootstrap
path; GitHub OIDC generates provenance automatically.

Publish from the repository root as shown, rather than passing the `.tgz` to
`npm publish`: directory publication lets npm record the current Git `gitHead`,
which the recovery workflow later verifies. The tarball is the audited preview
and install-test artifact.

### Initial npm setup

If the package does not exist on npm yet, bootstrap it once from the exact
committed `main` revision using the local release build above. If its Git diff
check fails, do not publish from that working tree; refresh the Release PR or
restore the committed version and lock first.

Synchronization preserves the build when the upstream App version changes. For
example, syncing `3.3.5-12` against ZCode App `3.4.0` produces `3.4.0-12`.

Before enabling publication:

1. confirm that `zcode-app-cli` is the npm package name you control;
2. confirm redistribution rights for the extracted ZCode runtime;
3. under the GitHub repository's **Settings** → **Actions** → **General**,
   enable **Allow GitHub Actions to create and approve pull requests**;
4. open the package on npmjs.com and select **Settings** →
   **Trusted Publisher** → **GitHub Actions**;
5. enter the GitHub organization or user, repository, and workflow filename
   `publish.yml`; leave the environment name empty because this
   workflow does not use a GitHub Environment, and select `npm publish` under
   **Allowed actions**;
6. save the publisher, prepare a `cli` release, and merge its Release PR to
   verify an OIDC publication.

The publisher runs on a GitHub-hosted runner with Node 24, grants
`id-token: write`, and updates npm to the current release. It never reads an
`NPM_TOKEN` repository secret; npm attaches provenance from the OIDC identity.
After verifying the first OIDC release, npm recommends setting **Publishing
access** to require 2FA and disallow tokens, then revoking any obsolete
automation token.

The publisher skips an identical existing version, refuses older versions,
verifies every existing npm release's `gitHead`, and refuses to reuse a tag
that points at another commit. The `latest` dist-tag therefore advances only
to the newest validated App-plus-build release.
