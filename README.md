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

The official agent, model, session, tool, plugin, MCP and login logic is not
reimplemented. The local package only supplies the missing terminal interface.

Node.js remains necessary because ZCode CLI 0.15.x imports `node:sea`, which Bun
does not currently implement. Bun owns the outer CLI and native terminal; Node
is the compatibility host for the unmodified upstream kernel.

## Current TUI functionality

- pi-tui differential rendering and CJK-aware multi-line editor;
- streamed assistant text from official ZCode session events;
- slash-command and workspace-path completion;
- persisted prompt history through ZCode's history API;
- `/mode`, `/model`, `/resume`, `/plugins` and other upstream slash commands;
- generic upstream selection dialogs;
- interactive tool-permission approval dialogs;
- active-turn steering, cancellation and error reporting;
- `/copy`, `/clear`, `/exit`, Ctrl+C and Ctrl+D handling;
- `--no-color` and `NO_COLOR` support.

## Requirements

- Bun 1.3 or newer;
- Node.js 22.19 or newer;
- macOS, Linux or Windows for `Bun.Terminal`;
- `7z` when downloading and extracting a remote installer.

Set `ZCODE_NODE=/absolute/path/to/node` when the desired Node.js executable is
not available on `PATH`.

## Model access and configuration

ZCode reads the user configuration from `~/.zcode/cli/config.json`. Choose one
of these model-access paths:

- Z.AI OAuth: run `zcode login`;
- direct API key with a custom provider: use the
  [`config.example.json`](./config.example.json) template and do not log in.

### Custom provider without login

From this source checkout, install the full template as the user config:

```bash
mkdir -p ~/.zcode/cli
cp config.example.json ~/.zcode/cli/config.json
chmod 600 ~/.zcode/cli/config.json
```

Then edit four values in `~/.zcode/cli/config.json`:

1. `provider.zai.kind`: use `anthropic`, `openai-compatible`, or `openai`;
2. `provider.zai.options.baseURL`: use the provider's API root;
3. `provider.zai.options.apiKey`: insert the direct API key;
4. replace `replace-with-model-id` in both `provider.zai.models` and `model`.

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

`check:tui` creates a real PTY, opens the full TUI, executes `/help`, switches
to plan mode, and exits. It uses a temporary home directory and does not require
an API call.

Start the client directly:

```bash
bun bin/zcode.ts
```

For the OAuth path:

```bash
bun bin/zcode.ts login
bun bin/zcode.ts
```

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
