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

# Exercise an allowlisted shell against the normal temporary workspace.
bun run test:tui:manual allowlisted-shell

# Opt into a kernel-mounted in-memory workspace when Mountx supports the host.
bun run test:tui:manual allowlisted-shell --workspace-backend=mountx
```

Manual mode prints the temporary workspace path before opening the TUI. Enter
`/exit` when finished; the workspace, HOME, and Git repository are then removed.

## Structure

- `test/tui/harness/terminal-session.ts` owns the PTY, input, output matching,
  timeouts, and failure diagnostics.
- `test/tui/harness/terminal-screen.ts` parses PTY bytes into the current
  visible terminal cells, including cursor movement, erasure, and alternate
  screen transitions. It uses the pinned experimental `@xterm/headless`
  buffer API so dependency upgrades must be reviewed explicitly.
- `test/tui/harness/scenario-workspace.ts` creates an isolated HOME and working
  tree with a separate real Git directory and deterministic configuration.
- `test/tui/scenarios/` declares user-visible actions and assertions.
- `test/tui/fixtures/` provides typed `RuntimeAdapter` behavior to the real TUI.
- `test/tui/runtime/scenario-runtime.ts` maps declared prompt routes to typed
  event, delay, permission, file-write, and response steps.
- `test/tui/runtime/scenario-http.ts` maps declared MSW routes to real fixture
  `fetch` calls, request assertions, responses, and exact call counts.
- `test/tui/runtime/scenario-shell.ts` runs bounded, allowlisted just-bash
  commands against the selected scenario workspace.
- `test/tui/harness/mountx-workspace-backend.ts` provides an explicitly
  requested in-memory kernel mount when the host has a usable transport.
- `scripts/tui-scenario.ts` exposes automatic and manual execution modes.

A scenario should describe behavior rather than terminal timing. Use
`waitForScreen()` or `sendAndWait()` to synchronize on visible state; do not
add fixed sleeps except for a short render settle. Use `waitForHistory()` only
for transient output that is intentionally no longer visible.

Runtime fixtures should use `createScenarioRuntime()` rather than implementing
`submitPrompt()` directly. Every turn must have a unique id and end in one
`respond` step. Unknown input fails unless the fixture declares an
`unmatchedResponse`. Permission batches explicitly choose parallel or
sequential execution, delays observe the turn abort signal, and writes cannot
escape the scenario workspace. Runtime steps are also written to
`runtime.jsonl`; automatic failures include that journal in their diagnostics.

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

Network scenarios use `createScenarioHttpMock()` inside the child fixture.
Routes declare a unique id, HTTP method, URL, response, and optional exact call
count and request assertion. Responses support JSON, text, empty bodies,
latency, and network errors. Unhandled requests and failed assertions are
recorded and cause `assertSatisfied()` to fail. Use one shared
`ScenarioRuntimeJournal` for the runtime and HTTP mock so diagnostics preserve
execution order. This intercepts the fixture's real `fetch`; an MSW server in
the parent test process cannot intercept child-process requests.

Call `httpMock.start()` before `runTui()`, call `httpMock.assertSatisfied()`
after it exits, and use `using` or `close()` to restore the process network
state. Do not allow unhandled requests to reach the public network.

Shell scenarios use `createScenarioShell()` with just-bash's hardened execution
limits, a fixed command allowlist, no network, no JavaScript or Python runtime,
and a `ReadWriteFs` rooted at the scenario workspace. Writes therefore remain
visible to the TUI's real Git diff. Native Git is deliberately absent from the
shell; Git assertions continue through `ScenarioWorkspace.git()` with the
isolated configuration described above. just-bash executes in the fixture
process and is not a VM or container security boundary.

The default workspace backend remains a normal temporary directory because it
is portable and exercises the fewest layers. `--workspace-backend=mountx`
replaces only that directory with Mountx's in-memory driver mounted through the
host's selected transport. `MountxWorkspaceBackend` also accepts a custom
Mountx driver for operation journaling or deterministic fault injection. The
backend is opt-in because Mountx is alpha, requires OS mount support, and
exposes the mount to other host processes. It is not a sandbox.
The gated integration check can be run explicitly:

```bash
ZCODE_TEST_MOUNTX=1 bun test test/tui/scenario-mountx.test.ts
```

The completed backend boundary is:

| Need | Backend |
| --- | --- |
| Runtime responses and permission ordering | Typed scenario runtime |
| Deterministic `fetch` behavior | Strict child-process MSW |
| Common shell syntax and workspace writes | Allowlisted just-bash |
| Portable filesystem and real Git behavior | Temporary disk workspace |
| Kernel mount behavior or filesystem-driver faults | Opt-in Mountx workspace |
| Arbitrary binaries, Git hooks, or untrusted code | External container/VM |

Do not add host command passthrough to just-bash or treat Mountx as containment.
A scenario that crosses those constraints must move to an external
container/VM runtime test instead of weakening the hermetic TUI suite.

## Adding a scenario

1. Add a fixture under `test/tui/fixtures/` that calls `runTui()` with deterministic
   adapter functions.
2. Add a declaration under `test/tui/scenarios/` with optional baseline files
   and the automatic interaction.
3. Register it in `test/tui/scenarios/index.ts`.
4. Add a `bun:test` entry when the scenario should run as part of `bun test`.
5. Verify both automatic and `--manual` modes before enabling it in CI.
