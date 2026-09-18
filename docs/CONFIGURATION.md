# Configuration

English | [简体中文](CONFIGURATION.zh-CN.md)

The CLI follows the current ZCode runtime's provider registry schema. General
runtime settings and provider configuration live in separate files.

## Configuration files

| File | Purpose |
| --- | --- |
| `~/.zcode/cli/setting.json` | CLI theme, notifications, tools, storage and other runtime settings |
| `~/.zcode/v2/setting.json` | Existing Desktop language and memory preferences, read without modification |
| `~/.zcode/v2/provider_config.json` | Providers, model metadata overrides and the default model |
| `~/.zcode/v2/credentials.json` | Credentials persisted by the native runtime |

On Windows, use `%USERPROFILE%` in place of `~`. The provider file is shared
with ZCode Desktop by default: changing providers or the saved default affects
both clients. `/model` changes only the current CLI session.

Set `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` to a separate file to isolate provider
settings. `ZCODE_DATA_BASE_DIR` changes the native runtime's base directory,
including its provider and credential storage. General CLI settings still use
the user's `~/.zcode/cli/setting.json`.

On first launch, the CLI creates a credential-free general configuration from
[`setting.example.json`](../setting.example.json). Existing files are not replaced.
Provider settings are created by native login or configured using
[`provider.example.json`](../provider.example.json). The complete
[provider field reference](PROVIDER_CONFIG.md) explains every supported personal
configuration field, Desktop editor mapping and automatic catalog inheritance.

## Startup migration

The CLI follows the Desktop migration rules and uses the runtime's native parser
and file-locked provider repository. Desktop imports its legacy providers when
its native file is first created. CLI startup performs one additional, one-time
merge from `~/.zcode/cli/config.json`, because the shared provider file may
already have been created by Desktop.

Only missing personal provider IDs are added. Existing provider definitions,
model overrides, ordering and the shared default selection are preserved.
Account providers and encrypted secrets are excluded. Deleted models are
excluded; native model IDs and provider aliases are normalized by the upstream
parser. Unsupported provider configurations are recorded as skipped.

CLI-specific fields move to `~/.zcode/cli/setting.json`; provider, main/lite and
catalog-overlay fields are omitted. The original file remains intact. A marker
under `~/.zcode/cli/migrations/` records completion for each target provider file,
so later startup does not re-import providers that a user has deleted. A separate
`settings-v1.json` marker prevents a reset of CLI settings from importing the old
settings again. The old
file is never used as a runtime configuration fallback. Invalid new files are
reported rather than replaced by old settings.

## Setting ownership and precedence

| Setting or action | Read/write behavior |
| --- | --- |
| Providers and model metadata | Shared native `provider_config.json` |
| Default model in `/settings` | Writes the shared default and applies it to the current session |
| `/model`, model cycling and reasoning effort | Change/persist this session's native selection; shared default stays unchanged |
| `/new` | Reads the current shared default |
| Resume/restart | Restores the session's model and reasoning options |
| Language and memory | Reads Desktop `localePreference` / `memoryEnabled`; explicit CLI settings override these values |
| Theme, terminal layout, copy-on-select and notifications | CLI `setting.json` |
| Tool permissions, retries, stream timeout, CLI plugin/MCP options and other runtime settings | CLI `setting.json`, with native project/environment precedence |
| Update cache, diagnostic logs and migration state | Operational files beneath the CLI directory |

The CLI does not add keys to Desktop's `setting.json`. Notification and display
changes write only the CLI file. Shared preferences are applied while loading
runtime settings, not copied into CLI settings during unrelated updates.

## Model catalogs and default selection

The native registry loads the bundled catalog and manages upstream catalog
refreshes. `/model`, model cycling, and **Settings > Model providers** refresh
the current registry from its configuration sources. The session is retained.
The CLI does not keep a separate legacy model catalog cache.

`config.defaultModelSelection` in the provider file chooses the model for new
sessions. `/settings` saves that selection through the native repository and
applies it to the current session. `/model provider/model` is a temporary session
switch. A resumed session can retain its saved selection.

Reasoning options omitted from a saved selection are completed using that
model's registry defaults. Explicit reasoning choices remain intact.

## First-run setup

The setup wizard appears on the first interactive launch. Choose **Sign in**,
**Custom provider**, or **Skip for now**. `/setup` reopens it. A `setup-pending`
marker beside the general config survives non-interactive commands and is
cleared after successful configuration or an explicit skip. An existing native
provider configuration is recognized directly; no desktop import step is needed.

## Model access

- **Z.AI OAuth on macOS:** use `zcode login`, or `zcode login --oauth` to force
  authorization. `--no-browser` prints the authorization URL.
- **Z.AI/BigModel Coding Plan API key:** open `/login` and choose the masked
  API-key option. The official runtime owns credential and provider persistence.
- **Custom provider:** configure the native provider file directly. Any provider
  ID can be used; a separate OAuth login is unnecessary.

Plain `zcode login` recognizes a configured native default and reports its
configuration path. Configuration presence is checked locally; credential
validation and decryption belong to the runtime.

For macOS OAuth, the CLI temporarily registers a callback receiver, checks
`state`, restores the previous `zcode://` handler and sends the callback through
stdin. The runtime exchanges the token, stores encrypted credentials, resolves
the Coding Plan API key and saves the native default model. The TUI then rereads
provider configuration. BigModel uses the runtime's localhost callback.

## Custom provider

Use `provider.example.json` as a reference for a new provider file. Its enabled
model inherits the upstream catalog; its disabled reference models demonstrate
all smart-override and manual fields. Fill the empty API key, replace the
placeholder IDs/endpoint, and remove unused reference entries. When a file already
exists, merge the desired provider rule into it and preserve the other rules and
selections.

A minimal configuration uses this structure:

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "custom",
          "providerName": "Custom provider",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "YOUR_API_KEY" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "https://api.example.com/v1"
            },
            "personalModelIds": ["your-model-id"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "custom",
      "modelId": "your-model-id"
    }
  }
}
```

Use `anthropic-messages` for an Anthropic-compatible endpoint,
`openai-chat-completions` for Chat Completions, or `openai-responses` for the
Responses API. `baseUrl` is the API root; model IDs are case-sensitive.
The model reference is `providerId/modelId`.

```text
/model custom/your-model-id
/settings
/new
```

The native catalog supplies context limits, reasoning options and input/output
capabilities for known models. Custom metadata overrides belong in the native
`modelConfigRules`, including `properties.contextWindow`,
`properties.inputFormat` and `optionSpecs`. Image, video and PDF support follow
the selected model's registry metadata.

Use `properties.supportsJsonSchemaOutput`, `supportsNativeWebSearch` and
`supportsMidConversationSystem` for Desktop's three capability switches.
The maximum output limit is `optionSpecs.maxOutputTokens.max`; it is independent
of the context window. Request parameter mappings belong in each option's `map`
string. See the [complete field tables and examples](PROVIDER_CONFIG.md).

When the upstream catalog changes, smart models inherit the new capability
and option metadata automatically. Only explicit personal overrides remain fixed.
Runtime sync copies the complete catalog, and `/model` refreshes the live registry;
there is no need to write upstream capability values into every personal model.

## Permission and planning state

The CLI follows Desktop's three selectable permission modes: `build` (ask before
changes), `edit` (edit automatically), and `yolo` (full access). `/mode` opens the
picker; Shift+Tab cycles these three options. The internal `auto` value is not a
menu option.

`/plan` toggles planning independently. `/plan on` and `/plan off` set it
explicitly. Changing permissions keeps the Plan switch unchanged; toggling Plan
keeps the selected permissions unchanged. The native runtime owns validation,
including the restriction against enabling Plan while a Goal is active.

When enabled, `Plan` appears at the right end of the input's upper border without
adding a row. An empty editor shows a planning hint. The statusline always shows
the permission mode, and `/status` lists Mode and Plan separately. The marker
follows native state changes, including plan approval, new sessions and resume;
no separate CLI preference is written for Plan.

## Prompt access preflight

New headless prompts and ordinary TUI input diagnose missing provider setup or
an explicitly keyless API-key provider before a model turn starts. No key or
credential value is printed or checked over the network. Account authentication,
malformed configuration, environment overrides, project configuration and resumed
headless sessions remain the runtime's responsibility.

The TUI restores rejected input to an empty editor, or retains it in the
follow-up queue without replacing a newer draft. Headless commands exit with
setup instructions. Login, setup and other management commands remain usable.

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
user config: `~/.zcode/cli/setting.json` on macOS/Linux or
`%USERPROFILE%\.zcode\cli\setting.json` on Windows. An explicit dark/light value
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
values under `ui.notifications` in the cross-platform user `setting.json`:

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

Environment variables override `setting.json` on startup and are useful for a
temporary per-shell setting:

```bash
export ZCODE_TUI_NOTIFICATION_METHOD=auto       # auto|osc9|bel|native|off
export ZCODE_TUI_NOTIFICATION_CONDITION=always  # unfocused|always
zcode
```

## Official MCP Availability

When the bundled runtime has no official MCP trusted-origin registry, official
HTTP MCP services are reported as disabled with an `official_auth_unavailable`
diagnostic. Other plugin components remain available. This does not disable
certificate, origin, or permission checks, and does not suppress services when
the runtime provides the required registry. No user configuration is rewritten.
