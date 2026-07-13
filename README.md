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

If login is required:

```bash
bun bin/zcode.ts login
bun bin/zcode.ts
```

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

## Design principles

- KISS: Bun handles PTY orchestration and pi-tui handles terminal rendering.
- YAGNI: no replacement agent, model client or second TUI framework.
- DRY: the same local `@zcode/tui` build is used by local extraction and CI.
- SOLID: extraction, launching, event adaptation and terminal presentation are
  separate modules.
