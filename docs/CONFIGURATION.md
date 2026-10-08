# Configuration

English | [简体中文](CONFIGURATION.zh-CN.md)

The CLI follows the current ZCode runtime's provider registry schema. Provider
and model settings live in `provider_config.json`; MCP servers, hooks, plugins,
permissions and other general runtime settings live in the CLI's `setting.json`.

## Configuration files

| File | Purpose |
| --- | --- |
| `~/.zcode/cli/setting.json` | MCP servers, hooks, plugins, permissions, network, storage and CLI display settings |
| `~/.zcode/v2/setting.json` | Existing Desktop language and memory preferences, read without modification |
| `~/.zcode/v2/provider_config.json` | Providers, model metadata overrides and the default model |
| `~/.zcode/v2/credentials.json` | Credentials persisted by the native runtime |

On Windows, use `%USERPROFILE%` in place of `~`. The provider file is shared
with ZCode Desktop by default: changing providers or the saved default affects
both clients. `/model` changes only the current CLI session.

Set `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` to a separate file to isolate provider
settings. `ZCODE_DATA_BASE_DIR` changes the native runtime's base directory,
including its provider and credential storage. General CLI settings default to
the user's `~/.zcode/cli/setting.json`. Set `ZCODE_CLI_SETTINGS_FILE` to an absolute
file path to give one process its own settings. Unset or whitespace-only values
use the default. The selected file replaces the user settings source; explicit
runtime file paths and project configuration keep their existing precedence.

Legacy `config.json` and `migrations/` markers follow the selected file's directory.
Hook trust commands use that file's `storage.dir` too. Providers, credentials and
the session database (including persisted project permissions) have separate path
overrides; changing only the settings file does not isolate those stores. See
[host integration](HOST_INTEGRATION.md#environment-and-configuration) for examples.
Desktop preferences remain in `~/.zcode/v2/setting.json`; Desktop's user hooks and
MCP configuration in `~/.zcode/cli/config.json` are not continuously synchronized
with the CLI settings file.

On first launch, the CLI creates a credential-free general configuration from
[`setting.example.json`](../setting.example.json). Existing files are not replaced.
Provider settings are created by native login or configured using
[`provider.example.json`](../provider.example.json). The complete
[provider field reference](PROVIDER_CONFIG.md) explains every supported personal
configuration field, Desktop editor mapping and automatic catalog inheritance.

## App-server authentication

`zcode app-server` defaults to `standalone` authentication: it reuses the native
credentials saved by CLI login and supplies its own model-request auth. Log in
with `zcode login` before starting an account-backed session.

Clients that own account login must explicitly select `host` when spawning the
server:

```bash
ZCODE_APP_SERVER_AUTH_MODE=host zcode app-server
```

For a programmatic launcher, set `ZCODE_APP_SERVER_AUTH_MODE: "host"` in the child
process environment. Host mode preserves `provider/updateAccountConfig` and
`interaction/requestProviderRuntimeHeaders`; the client owns account updates
and request-credential refresh. It does not read the standalone credential file.

The mode is fixed for the server process. Restart to change it. Missing or
rejected credentials never switch to the other source; an unknown mode fails
startup. Standalone mode rejects host account updates. Personal API-key providers
remain available through the native provider configuration in either mode.

This follows the credential-ownership distinction in [Codex app-server
authentication](https://developers.openai.com/codex/app-server#authentication-modes).
ZCode selects the mode at startup and retains its native protocol; it does not
implement Codex's `account/login/start` or `account/read` endpoints.

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
| MCP servers | CLI `setting.json` → `mcp.servers`; [MCP precedence](#project-settings-and-plugins) applies to project and plugin servers |
| Tool permissions, retries, stream timeout, hooks, plugins and other runtime settings | CLI `setting.json`, with native project/environment precedence |
| Update cache, diagnostic logs and migration state | Operational files beneath the CLI directory |

The CLI does not add keys to Desktop's `setting.json`. Notification and display
changes write only the CLI file. Shared preferences are applied while loading
runtime settings, not copied into CLI settings during unrelated updates.

## MCP servers

Add servers under the top-level `mcp.servers` object in
`~/.zcode/cli/setting.json`. The keys are server names. `mcp`, `features`,
`permission`, `plugins` and `hooks` are siblings in this file; the
`schemaVersion` / `config` wrapper belongs to `provider_config.json`.

Merge this example into your existing settings, replacing the endpoint and
executable with your own running HTTP server and installed stdio server:

```json
{
  "features": {
    "mcp": true
  },
  "mcp": {
    "servers": {
      "basic-memory": {
        "type": "http",
        "url": "http://127.0.0.1:18796/mcp"
      },
      "token-savior": {
        "type": "stdio",
        "command": "/absolute/path/to/token-savior-mcp",
        "args": [],
        "timeoutMs": 30000
      }
    }
  }
}
```

The runtime reads this file on startup. Restart ZCode after changing MCP
settings. The `settings-v1.json` marker only controls migration from the old
CLI `config.json`; it does not prevent later edits to `setting.json` from loading.
Changing the model/provider file or completing provider login does not configure
custom MCP servers.

### Server fields

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | All | `"stdio"`, `"http"` or `"sse"`; use the transport supported by your server |
| `command` | stdio | Executable name or absolute path; put command arguments in `args` |
| `args` | stdio | Optional array of strings |
| `env` | stdio | Optional object of environment variable names to string values |
| `cwd` | stdio | Optional working directory for the server process |
| `url` | HTTP / SSE | Server endpoint, including its MCP or SSE path |
| `headers` | HTTP / SSE | Optional object of header names to string values, such as `Authorization` |
| `oauth` | HTTP / SSE | Optional OAuth configuration; see below |
| `enabled` | All | Set to `false` to disable a server while keeping its configuration |
| `timeoutMs` | All | Optional positive number in milliseconds; use this field instead of `timeout` or `startup_timeout_sec` |
| `protocolVersion` | All | Optional `"auto"`, `"legacy"` or `"2026-07-28"` in runtime 0.16.9; normally leave unset for automatic negotiation |

For OAuth, `oauth.type` accepts `"authorization_code"` or `"client_credentials"`.
Both accept `clientId`, `clientSecret`, `clientName` and `scope`; client credentials
requires `clientId` and `clientSecret`, while authorization code also accepts
`redirectPath`. Configure these only when required by the MCP server.

### Project settings and plugins

Project `zcode.json` or `.zcode/config.json` files use the same `mcp.servers`
structure. In a Git worktree, the runtime discovers those files from the worktree
root through the working directory; outside a worktree, it checks the working
directory. For project stdio servers, relative `cwd` values resolve against the
project configuration's base directory (the parent of `.zcode` for
`.zcode/config.json`); an omitted `cwd` uses that directory.

MCP servers merge by name. **User settings take precedence over project settings
for the same server name** in the current runtime; distinct names from both
sources remain available. This is an exception to the usual project-override
rule for other settings. An empty user `mcp.servers` object does not disable
project or plugin servers. Use `enabled: false` on a named server, or
`features.mcp: false` to disable MCP as a whole.

Enabled plugins also contribute servers. Their definitions come from the
plugin's `.mcp.json` or manifest, and normally appear as
`plugin:<plugin-name>:<server-name>`. Keep standalone user MCP definitions in
`setting.json`; this CLI does not automatically read `.agents/mcp.json`.
Plugin controls remain under `plugins`, hook declarations under
`hooks.events.<Event>`, and tool permissions under `permission` in `setting.json`.

### Upstream source and file paths

These paths distinguish the packaged CLI from the upstream application. The
source references below are pinned to upstream
[`29628c9` / `v3.14.3`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e).
This package's runtime lock selects the separate Desktop 3.14.4 artifact; the
public source snapshot is not an assertion of that artifact's build commit.

| Client / source | User MCP file | JSON path |
| --- | --- | --- |
| Unpatched upstream CLI | `~/.zcode/cli/config.json` | `mcp.servers` |
| This package, `zcode-app-cli` | `~/.zcode/cli/setting.json` | `mcp.servers` |
| Upstream Desktop's ZCode directory source | `~/.zcode/cli/config.json` | `mcp.servers` |
| Upstream Desktop's `.agents` fallback | `~/.agents/mcp.json` | `mcpServers` |

The upstream [file loader](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L61-L118)
defaults to `config.json`. This package's
[`patchRuntimeSharedConfig`](https://github.com/kingsword09/zcode-cli/blob/e93caf41292314bd751180cf9b08f6d18895a5b5/scripts/sync-runtime.ts#L1026-L1046)
changes that filename to `setting.json`. The
[general-settings schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/schema.ts#L286-L306)
contains `mcp`, `plugins`, `permission` and `hooks`. The separate, strict
[provider-file schema](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/provider-node/src/provider-config-file-codec.ts#L18-L30)
accepts provider/model rules, provider order and default model selection; adding
MCP there fails its schema validation. The
[MCP merge function](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/config/config-factory.ts#L372-L397)
explicitly applies user definitions after project definitions.

Desktop has a separate
[MCP directory reader and writer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/mcpUserDirectory/index.ts#L37-L69).
For each user/project scope, it
[falls back to `.agents/mcp.json`](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/desktop/src/main/mcpUserDirectory/index.ts#L334-L375)
when that scope's ZCode file has no MCP entries. Project files are
`.zcode/config.json` and `.agents/mcp.json`, respectively. Sharing
`provider_config.json` with Desktop does not synchronize these user MCP files
with this package's `setting.json`; the old CLI file is only imported during the
one-time migration described above.

### Checking whether settings loaded

Run `zcode doctor` to inspect configuration paths, loading status, validated MCP
server names and their user/project sources. For a report suitable for debugging:

```bash
zcode doctor --json
zcode --cwd /path/to/project doctor --json
```

The JSON output keeps the existing runtime metadata and adds `configuration`:
`user.path` / `user.status`, `project.paths` / `project.status`, `mcp.enabled`,
`mcp.servers` and `diagnostics`. Status is `loaded`, `missing` or `invalid`.
Diagnostics identify the file and rejected field. Server records include only
name, transport, enabled state and source; command arguments, URLs, environment
variables, headers and credentials are omitted. `provider.path` identifies the
provider file; this check does not validate provider credentials.

Doctor works without login and even when `setting.json` contains invalid JSON.
It skips first-run settings creation and provider migration, and reports the old
`config.json` as a migration source only. It does not start MCP servers or send
model requests. A missing settings file is allowed; rejected settings or skipped
MCP entries produce exit code `1`. Valid configuration produces exit code `0`.

The server list covers user/project configuration. Plugin and built-in MCP
servers are added separately at session startup, and this check does not test
connectivity. Use `/status` in the TUI to inspect connected MCP servers. The
default structured runtime logs are under `~/.zcode/cli/log/`. When a server is
missing, these events provide the session's loading and connection evidence:

| Event | What to check |
| --- | --- |
| `bootstrap.app.startup.config.completed` | `context.configSourceUser` indicates whether the user settings file loaded |
| `config.file.invalid` | `context.configPath` and `context.diagnosticMessage` identify a file-level parsing or schema error |
| `config.mcp_server.skipped` | `context.diagnosticPath` and `context.diagnosticMessage` identify an invalid server entry |
| `mcp.configured_servers.connect.started` | `context.serverNames` lists the servers selected for connection |
| `mcp.configured_servers.connect.completed` | Connection status and tool counts distinguish loading from connection failures |

Valid JSON must also satisfy the runtime schema. A schema error outside an
individual MCP server entry can cause the entire settings file to be ignored.
For example, `ui.theme: "system"` is invalid; supported values are `"auto"`,
`"dark"` and `"light"`. In that case the runtime can still start with default
settings and plugin servers. `features.mcp` defaults to `true`, so seeing MCP
enabled does not prove the user file loaded. A malformed individual server entry
is skipped with `config.mcp_server.skipped`; valid entries can still load.

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
