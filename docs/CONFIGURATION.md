# Configuration

This document covers the detailed model-access configuration for
zcode-app-cli. For installation and basic usage, see the
[main README](../README.md).

## Configuration file location

On first launch, ZCode recursively creates the configuration directory and a
credential-free `config.json` when it is missing. Existing files are never
replaced. The location is `~/.zcode/cli/config.json` on macOS and Linux, and
`%USERPROFILE%\.zcode\cli\config.json` on Windows. Newly created directories
and files use private permissions on POSIX; Windows keeps the current user's
inherited ACLs.

The generated file contains the complete non-secret configuration shape plus
valid Z.AI model metadata, but deliberately omits `apiKey` until one is
configured. This lets the official runtime and TUI start cleanly without
pretending that model access is already configured. Choose one of the
model-access paths below before sending a prompt.

## Model-access paths

Three model-access paths are supported:

- **Z.AI OAuth on macOS**: run `zcode login` when no provider is configured, or
  `zcode login --oauth` to force reauthorization;
- **Z.AI/BigModel Coding Plan API key**: open `/login` in the TUI and choose the
  matching masked API-key option;
- **Direct API key with a custom provider**: use the
  [`config.example.json`](../config.example.json) template and do not log in.

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

### Using the custom provider

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

Project-level overrides are read from `zcode.json` or `.zcode/config.json` in
the working directory. Running `/model` does not call the provider, so it is a
safe configuration check before the first prompt.

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

## Theme

Set `ui.theme` to `"auto"` (terminal detection), `"dark"`, or `"light"` in the
user config: `~/.zcode/cli/config.json` on macOS/Linux or
`%USERPROFILE%\.zcode\cli\config.json` on Windows. An explicit dark/light value
takes priority over terminal probing. `auto` queries the terminal background
color and color scheme at startup and re-applies the matching palette.

## Turn completion notifications

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
