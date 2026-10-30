# Required test contracts

This suite is rebuilt around failures that can lose user data, cross an account
or permission boundary, block a command, or ship an unusable package. It targets
the runtime in `zcode-runtime.lock.json`, not historical runtime implementations.
Passing this suite is a release baseline, not proof that every feature is covered.

## Run

```sh
bun run sync:locked
bun run typecheck
bun run test
bun run check
bun run check:tui
bun run release:pack
```

`test` and `test:all` run unit, TUI, native runtime and real Node storage tests
sequentially. `test:unit` is the fast offline subset. Use the package commands:
bare `bun test` incorrectly discovers the Node-only `.test.cjs` files with Bun.
Runtime and storage tests require a built, synchronized runtime; no user API key
or model service is required. HTTP endpoints and credentials are local fixtures.

The rebuilt baseline contains 97 cases in 29 files:

| Group | Files | Cases |
| --- | ---: | ---: |
| Offline contracts | 11 | 37 |
| Terminal wiring | 5 | 14 |
| Native runtime | 10 | 31 |
| Real Node persistence | 3 | 15 |

Counts describe this reset, not an assertion that future suites must have a fixed size.

## Why each file exists

### Offline contracts: `test:unit`

| File | Failure this must prevent |
| --- | --- |
| `config-bootstrap.test.ts` | Startup overwrites user settings, creates public settings, races another startup, or ignores a host-selected file. |
| `app-server-client.test.ts` | A response goes to the wrong request, protocol errors disappear, or cancellation leaves a process running. |
| `app-server-auth.test.ts` | Local credentials are used in host mode, or an invalid mode silently selects an account. |
| `shared-oauth.test.ts` | Logout/account switching reuses stale identity, or a login publishes the wrong token kind. |
| `prompt-preflight.test.ts` | A keyless prompt starts work, an explicit model is ignored, or a malformed config is silently replaced. |
| `input-queue.test.ts` | Accepted input is edited, steers are lost/duplicated, or delayed events attach input to the wrong turn. |
| `permission-request-queue.test.ts` | Permissions overlap, survive cancellation, or stop processing after one failure. |
| `attachments.test.ts` | Malformed image data reaches the runtime. |
| `rewind.test.ts` | Rewind selects the wrong message or admits an invalid workspace operation. |
| `release-contract.test.ts` | Package and runtime versions diverge, installer verification is weakened, or a lagging manifest downgrades the lock. |
| `shell-security.test.ts` | The shell formatter's known unbounded-precision denial of service returns. |

### Real runtime boundaries: `test:runtime`

| File | Failure this must prevent |
| --- | --- |
| `launcher.test.ts` | Keyless prompts run, missing sessions leak diagnostics, or a local plugin cannot be installed and discovered. |
| `app-server-auth.test.ts` | Real protocol turns use the wrong credential owner, fail to rotate keys, or fall back from missing credentials to host authentication. |
| `settings-file.test.ts` | Runtime writes and trust changes escape a host-selected settings store or change native MCP precedence. |
| `config-migration.test.ts` | Migration loses providers, overwrites conflicting/invalid configuration, or runs twice concurrently. |
| `shared-oauth.test.ts` | Native login stores plaintext/wrong tokens, ignores Desktop account changes, or damages shared login state on an HTTP failure. |
| `network-retry.test.ts` | A reset/unfinished stream silently truncates output, duplicates partial output on retry, or reports success after exhaustion. |
| `session-lifecycle.test.ts` | An untouched session is saved, rename/resume loses data, or failed work becomes unresumable. |
| `session-model-recovery.test.ts` | An invalid saved model sends a request, cannot be repaired and persisted, or falls back from an unavailable explicit model. |
| `guarded-permission-tui.test.ts` | A destructive command executes before single-use approval. |
| `workspace-paths.test.ts` | The actual runtime cannot find nested workspace files. |

### Real Node persistence: `test:node`

| File | Failure this must prevent |
| --- | --- |
| `session-lifecycle.test.cjs` | Concurrent first writes create duplicate sessions or failed title writes claim success. |
| `sqlite-session-store.test.cjs` | Migration races corrupt the database, lock exhaustion commits data, killed writes survive rollback, or native timeout policy disappears. |
| `sqlite-recovery.test.cjs` | Retrying duplicates records/counters, enters a caller's transaction, blocks the event loop, loses update order, or persists work after close. |

Use Node's SQLite driver, never Bun's substitute. Lock holders are separate
processes; databases and homes are temporary. Production-length lock delays and
large process-count stress runs are not part of this baseline.

### Real terminal wiring: `test:tui`

| File | Failure this must prevent |
| --- | --- |
| `input-actions.test.ts` | Keyboard queue operations lose drafts or attach an image to a different question. |
| `permission-request-queue.test.ts` | The actual TUI cannot answer concurrent permissions in order. |
| `startup.test.ts` | Input submits before initialization, cancelled startup reopens the UI, or a failure leaves raw mode enabled. |
| `terminal-exit.test.ts` | Regular/fullscreen exit or cancellation leaks input into the parent shell or returns the wrong status. |
| `write-and-diff.test.ts` | A tool's workspace write cannot be inspected through the TUI and real Git diff. |

`check:tui` adds one real-runtime first-run/login/command/SIGHUP flow. The release
pipeline also synchronizes and verifies required runtime patches, validates the
package tree, then packs and installs the resulting tarball. These checks replace
tests that only searched implementation text for patch strings or YAML commands.
Additional CI jobs reuse that exact tarball on other Node/OS versions; they do
not retest old runtime versions.

## What is deliberately outside the baseline

Exact rendered strings, Markdown prefix matrices, theme/font/spacing details,
notification combinations, benchmark thresholds and test-harness self-tests are
not default gates. Manual scenarios and performance tools remain available for
targeted investigation, but are not implied to run in CI. This removes coverage
as well as noise; restore a focused behavioral test when a concrete risk warrants it.

Add a test only when its observable failure is not already exercised here.
Prefer one success and one meaningful failure boundary over a combinatorial
matrix. A test using fake runtime objects cannot replace a native persistence,
authentication or permission test. Keep cold-start budgets separate from normal
interaction deadlines; do not fix failures by skipping assertions or adding sleeps.
