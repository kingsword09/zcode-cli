# TUI scenario testing

TUI scenarios drive the real `runTui` process through a pseudo-terminal while
replacing the remote runtime with deterministic fixture code. The same fixture
can be run by CI or opened interactively for visual inspection.

## Test groups

The project has three execution groups based on cost and environment:

```bash
# In-process unit, component, and lightweight integration tests.
bun run test:fast

# Hermetic PTY scenarios with a fixture runtime.
bun run test:tui

# Tests that require vendor/zcode.cjs, Node, sockets, or local networking.
bun run test:runtime

# Run the three groups in order.
bun run test:all
```

`bun run test` intentionally aliases the fast group for normal development.
The built-in `bun test` command still discovers every `*.test.ts` recursively,
so it behaves like the complete suite and requires a synchronized runtime.
Run `bun run sync:local` first when testing against an installed macOS App. In
a Delta worktree, use `TMPDIR=/tmp bun run test:runtime` to keep Unix socket
paths below the platform limit.

## Commands

```bash
# List TUI scenarios.
bun run test:tui-scenario --list

# Run all TUI scenarios automatically.
bun run test:tui

# Run one scenario automatically.
bun run test:tui-scenario permission-request-queue

# Open the same scenario for manual interaction.
bun run test:tui:manual permission-request-queue

```

Manual mode prints the temporary workspace path before opening the TUI. Enter
`/exit` when finished; the workspace, HOME, and Git repository are then removed.

## Structure

- `test/tui/harness/terminal-session.ts` owns the PTY, input, output matching,
  timeouts, and failure diagnostics.
- `test/tui/harness/scenario-workspace.ts` creates an isolated HOME and working
  tree with a separate real Git directory and deterministic configuration.
- `test/tui/scenarios/` declares user-visible actions and assertions.
- `test/tui/fixtures/` provides typed `RuntimeAdapter` behavior to the real TUI.
- `scripts/tui-scenario.ts` exposes automatic and manual execution modes.

A scenario should describe behavior rather than terminal timing. Use
`waitFor()` or `sendAndWait()` to synchronize on visible state; do not add fixed
sleeps except for a short render settle.

## Isolation and Git

Every run receives a new operating-system temporary directory:

```text
scenario root/
  home/
  workspace/
    .git          # pointer to the separate Git directory
  git/
  hooks/
```

Global and system Git configuration, credential prompts, pagers, signing, and
hooks are disabled. Scenario files are committed as a baseline. Writes are
therefore visible both to the fixture and to the TUI's production
`readWorkspaceDiff()` implementation. `ScenarioWorkspace.reset()` restores the
baseline, and disposal deletes the entire root.

Use real Git for Write/Edit and `/diff` scenarios. A scripted Git runner should
only be introduced for errors that are difficult to produce safely, such as a
missing executable, timeout, or malformed output.

## Runtime, network, and shell backends

Runtime responses belong in the child fixture, not the parent test process.
This keeps automatic and manual modes identical.

The first backend is intentionally the portable temporary-directory workspace:
it exercises the actual filesystem and Git without requiring FUSE/NFS setup.
It is test isolation, not a security boundary.

Future backends should preserve the same scenario contract:

- Mountx may provide an optional in-memory mounted workspace for filesystem
  journaling and fault injection. It must not be treated as a sandbox.
- MSW should be initialized inside each fixture process with unhandled requests
  configured as errors. Parent-process interception cannot mock child fetches.
- just-bash may execute allowlisted shell behavior against the scenario
  workspace. It should not expose unrestricted host commands or native Git.
- Scenarios requiring arbitrary binaries, Git hooks, or untrusted code belong
  in a container backend.

## Adding a scenario

1. Add a fixture under `test/tui/fixtures/` that calls `runTui()` with deterministic
   adapter functions.
2. Add a declaration under `test/tui/scenarios/` with optional baseline files
   and the automatic interaction.
3. Register it in `test/tui/scenarios/index.ts`.
4. Add a `bun:test` entry when the scenario should run as part of `bun test`.
5. Verify both automatic and `--manual` modes before enabling it in CI.
