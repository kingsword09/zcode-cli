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

## First-run setup wizard

When the TUI starts while model access has not been set up, a setup wizard
opens automatically. ZCode tracks this with a `setup-pending` marker file next
to `config.json`: it is written when the credential-free default config is
first created, survives non-interactive commands (`zcode plugin list`,
`zcode -p …`, `app-server`, …) so the wizard still appears on the first
interactive TUI start, and is cleared once setup is handled — finishing or
explicitly skipping the wizard, choosing the custom-provider help entry,
deferring the post-import sign-in, or configuring model access by any other
means (`zcode login`, a hand-edited `config.json`), in which case the wizard
does not appear at all. The marker is only kept when login or the desktop
import was attempted and failed, so an unconfigured user is guided again on
the next start. Press Esc to skip the wizard. It can be reopened anytime with
`/setup`, and it never appears for an existing configuration unless invoked
manually.

### Importing settings from the ZCode desktop app

The desktop import copies the selected desktop provider family (Z.AI or
BigModel): provider name, `baseURL`, and the desktop model list (merged into
the existing models, desktop IDs first). `model.main` keeps the current
selection when the model ID exists on both sides (case-insensitively),
otherwise it falls back to the first available of `glm-5.2`/`glm-5.3` (or the
desktop list's first model); `model.lite` falls back to `glm-5-turbo` and then
to the selected main model, so both selections always reference models that
exist after the import. A backup of the pre-import `config.json` is written
next to it as `config.json.pre-migration.bak`; if the backup cannot be
written, the import is aborted before any change is made.

Desktop credentials are never copied: the desktop app stores them encrypted
(`enc:v1:`) with a key held by the desktop process, and the CLI reads desktop
files only. After importing, sign in once via the offered login step (or
`/login` later) so a fresh Coding Plan API key lands in the CLI config. An
existing CLI-side `apiKey` for the same provider is always preserved.

## Model-access paths

Three model-access paths are supported:

- **Z.AI OAuth on macOS**: run `zcode login` when no provider is configured, or
  `zcode login --oauth` to force reauthorization; add `--no-browser` to print
  the authorization URL instead of opening a browser (useful over SSH);
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

### Adding a multimodal model

Each entry under `provider.<id>.models.<model-id>` is a catalog record. The
runtime reads these optional fields to decide whether a model accepts image,
PDF, or video input:

| Field | Type | Purpose |
| --- | --- | --- |
| `attachment` | boolean | When `true`, the model accepts file/image attachments. This is the flag the bundled catalog uses for vision models such as `glm-5v-turbo`. |
| `supportsImages` | boolean | Explicit image-input gate. The runtime drops image blocks for models where this resolves to `false`. |
| `supportsPdf` | boolean | PDF input gate. |
| `supportsVideo` | boolean | Video input gate. |
| `modalities.input` | string[] | Enumerated input modalities: `text`, `audio`, `image`, `video`, `pdf`. |
| `modalities.output` | string[] | Enumerated output modalities (usually `["text"]`). |
| `limit.context` | number | Context window in tokens. |
| `limit.output` | number | Max output tokens. |

Any one of `attachment: true`, `supportsImages: true`, or listing `"image"`
under `modalities.input` is sufficient — they are equivalent paths the
runtime checks. Declaring all three is the safest, most readable form.

To add `glm-5.3-flash` as a multimodal model under the `zai` provider:

```json
{
  "provider": {
    "zai": {
      "kind": "anthropic",
      "name": "Z.AI Coding Plan",
      "options": {
        "apiKeyRequired": true,
        "baseURL": "https://api.z.ai/api/anthropic"
      },
      "headers": {},
      "models": {
        "glm-5.3-flash": {
          "name": "GLM-5.3-Flash",
          "attachment": true,
          "supportsImages": true,
          "supportsPdf": true,
          "supportsVideo": true,
          "modalities": {
            "input": ["text", "image", "video", "pdf"],
            "output": ["text"]
          },
          "limit": { "context": 1000000, "output": 128000 }
        }
      }
    }
  },
  "model": {
    "main": "zai/glm-5.3-flash",
    "lite": "zai/glm-5-turbo"
  }
}
```

Then point `model.main` (and optionally `model.lite`) at the new id. The
`model` block stays strict — only `main` and `lite` are accepted; multimodal
capability is declared in the provider catalog entry above, never inside
`model`.

After saving, verify the picker sees the capability:

```text
/model   # should list zai/glm-5.3-flash with image input enabled
```

Attach an image from the clipboard with `Ctrl+V` or `/paste-image`; pending
images appear as `[Image #N]` tokens above the editor and are sent with the
next prompt. The runtime silently drops image blocks for models that resolve
`supportsImages` to `false`, so a vision model is required to actually send
the attachment upstream.

### Using the custom provider

After saving the config, no login command is required. Start the client:

```bash
zcode
```

From a source checkout, use `bun run dev` instead (see
[Development](./DEVELOPMENT.md)).

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

### Background agents

Long-running Agent calls automatically detach from the foreground turn after
one second and remain available through `/tasks`. Short Agent calls stay inline
so the current response can use their result without a notification round trip.
Configure the threshold in milliseconds:

```json
{
  "subagents": {
    "autoBackgroundMs": 1000
  }
}
```

Set the value to `0` to disable automatic backgrounding. Agent tool calls that
use `run_in_background: true` detach immediately regardless of this threshold.

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

## Runtime diagnostics

The interactive TUI captures runtime `stderr` so background diagnostics cannot
overwrite terminal rendering. A non-zero runtime exit prints its status and the
diagnostic path after the TUI stops. The active log is capped at 2 MB and rotated
to `.1` on the next launch; both files use owner-only permissions.

The default path is `~/.zcode/cli/tui-runtime.log`. Override it when collecting
diagnostics in an isolated environment:

```bash
ZCODE_TUI_RUNTIME_LOG=/tmp/zcode-tui-runtime.log zcode
```

## TUI display mode

The interactive TUI uses regular scrollback output by default. Set
`ui.tuiMode` to `"fullscreen"` to use the terminal's alternate screen with an
independently scrollable transcript, a fixed composer, and mouse-wheel/
scrollbar navigation. The composer remains available while older transcript
content is being reviewed. The scrollbar is hidden when the transcript fits,
then appears briefly while scrolling and follows the active dark/light theme.

```json
{
  "ui": {
    "tuiMode": "fullscreen"
  }
}
```

The same setting can be changed from `/settings` (or `/config`) under **Display
mode**. `ZCODE_TUI_MODE=fullscreen` or `ZCODE_TUI_MODE=regular` temporarily
overrides the saved value for the current shell; the settings picker labels
this override and does not remove it.

Fullscreen mode is restored on normal exit and on handled `SIGINT`, `SIGTERM`,
or `SIGHUP` shutdowns. A hard `SIGKILL` cannot be intercepted by any terminal
application.

### Copy on select

Releasing a mouse selection in fullscreen mode copies the selected text to the
system clipboard. Set `ui.copyOnSelect` to `false` to keep copying manual:
drags then only highlight, and the terminal's native selection (hold Shift or
the modifier your emulator documents while dragging) still works. The setting
only affects fullscreen mode; regular scrollback mode has no mouse selection.
The same toggle is available in `/settings` under **Fullscreen copy on
select**.

```json
{
  "ui": {
    "copyOnSelect": false
  }
}
```

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
zcode
```
