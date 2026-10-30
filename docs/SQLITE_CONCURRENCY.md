# SQLite contention recovery (#162 / #163)

## Ordinary writes and maintenance

The local compatibility bridge installs recovery on the native session store
after successful migration. The upstream store remains the owner of SQL,
transactions, IDs and session state. No schema changes or whole-turn retries are
introduced.

- Audited input, message, session, permission and todo operations may retry
  `SQLITE_BUSY` (including its extended codes). An operation retries only after
  its transaction has rolled back, or when its existing ID-based writes are
  idempotent. `SQLITE_LOCKED`, constraint, filesystem and other errors propagate.
- Writes through the bridge serialize by database path within one process.
  Conversation writes precede queued usage maintenance; ordering within each
  class is FIFO. Existing externally owned transactions retain native behavior
  and are never replayed by the bridge. Counter/goal and legacy workflow writes
  are serialized but not replayed because a partial commit is not idempotent.
- Retryable operations use a 25 ms native busy wait, scoped to each synchronous
  SQLite call. The original connection timeout is restored before returning
  from that call, including failures. Async backoff uses jitter and a maximum
  delay of 200 ms. The total budget is 30 seconds, including time spent in the
  local queue. Busy usage writes serve pending conversation writes between
  attempts while later usage writes remain ordered behind them.
  A synchronous SQL statement already executing cannot be preempted.
- Closing a store cancels its queued writes and backoff. Exhaustion preserves
  the SQLite cause and reports the operation, attempts and elapsed time. Model
  calls, shell commands and completed tools are outside the retry boundary.
- Automatic usage cleanup runs at most once per connection per five minutes,
  after checking whether any rows are expired. A busy cleanup is deferred for
  one second and does not fail an already committed usage fact. Explicit
  `beforeTime` cleanup requests retain the upstream behavior and error handling.
  Retention remains 30 days, and successful usage writes are never buffered.

The synchronous dynamic-workflow journal and synchronous permission-mode API
retain their native contract and timeout. They do not acquire an async retry
capability through this bridge. Cross-process contention is coordinated by
SQLite and bounded backoff, not by the process-local queue.

The operation allowlist and maintenance SQL were reviewed against upstream
`zai-org/ZCode` commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`.
On 2026-10-20 the store implementation was rechecked against
`0a1fc56d279fd1001f78387bd81aec1c26767411` (public 0.17.0 / Desktop 3.16.2).
On 2026-10-23 it was rechecked again against Desktop 3.16.3, which keeps runtime
0.17.0 but makes `commitForkBundle`, `commitSharedContextImportBundle` and
`transitionSharedContextImport` commit synchronously, so no transaction stays
open across an `await`.
The Desktop 3.17.1 / runtime 0.17.1 audit also covers `commitMessageBundle`:
its synchronous message/part transaction rolls back before throwing and uses
stable IDs. Recovery requires this method and retries the complete bundle,
including compaction and multi-part message persistence.
The 0.17.0 revision replaces the synchronous constructor and the separate
`openStartup()` migration with one `SqliteSessionStore.open()` path, adds
`softDeleteSession`, and runs checksum-validated migrations with a backup
directory. These source references do not identify the separate Desktop
artifact's build commit.
The required `sqlite-write-recovery` patch validates the single post-migration
hook and the native cleanup transaction. Missing, ambiguous or partially
patched anchors stop synchronization. The implementation is in
`src/runtime-sqlite-recovery.ts`, with scoped native waits and cleanup admission
in its two SQLite helpers; `vendor/cli-config.cjs` is their existing
distribution boundary.

Required regression coverage includes the single store-open path, recovered and
exhausted locks, responsive timers during backoff, same-process connections,
input-promotion rollback, ordered updates, close during recovery, preserved
non-BUSY errors, and sustained writes from 10–15 independent processes. Cleanup
tests must verify retention and that repeated usage writes do not each open a
cleanup transaction. All storage regressions run on real Node SQLite against
the extracted release artifact.

## Original timeout mitigation

The CLI's shared session database uses SQLite WAL. Readers can overlap a writer,
but different CLI processes still serialize writes to this file. The original
#163 mitigation sets a 10-second connection timeout after initialization. This
remains the default outside the scoped retryable calls described above.
Desktop 3.16.3 opens the store once through `SqliteSessionStore.open()`; its
migration helper restores a 5-second `busy_timeout` in `finally`, so the patch
re-applies 10 seconds on the same connection before the store is returned.
Startup migration lock budgets, short busy waits, backoff, rollback, and failure
cleanup are unchanged. The runtime creates a migration backup under the CLI data
root and validates `schema_migration` checksums before applying SQL.

This is a bounded contention mitigation, not unlimited concurrency or a retry of
an entire agent turn. A lock held beyond the budget can still fail. The change
does not migrate historical data or alter the database schema. Do not delete the
database or its WAL/SHM files to work around a lock while processes are using it.

## Reproduce and verify

Use Bun 1.4.1 for building and Node >=22.19.0 for the CLI and storage tests:

```sh
bun install --frozen-lockfile
bun run sync:locked
bun run test:node
```

The Node tests use the actual vendored `SqliteSessionStore`, temporary databases,
and independent Node processes. They do not use account credentials or send model
requests. They cover:

- the effective `PRAGMA busy_timeout` after sync open, async startup, and reopen;
- a native session write blocked by another process for 6.5 seconds, longer than
  the previous 5-second timeout, then succeeding exactly once;
- recovery after a 10.5-second lock, with timers progressing during backoff;
- a deliberately shortened recovery budget that reports `SQLITE_BUSY`, writes
  no session, and permits a later write after the lock is released;
- four independent processes migrating the same fresh database and persisting
  distinct sessions without duplicate migrations or integrity errors;
- killing a writer with uncommitted changes, then reopening without those changes
  and successfully writing another session;
- same-process connections completing an asynchronous native transaction without
  starving its commit, plus caller-owned transactions retaining rollback ownership;
- a failure after message/part insertion that rolls back before input promotion
  retries, and an idempotent partial part write that cannot overtake a newer update;
- a partial message bundle rolling back before replay, without duplicate messages
  or parts, and rejection of stores missing the native bundle transaction;
- non-BUSY errors and partially committed goal counters never being replayed;
- closing a store cancelling both backoff and pending writes;
- 100 usage facts requiring one cleanup transaction when expired rows exist,
  with recent records retained and explicit cleanup still honored;
- retrying usage writes yielding priority to conversation writes;
- twelve independent processes persisting 300 input promotions and matching
  messages, parts and usage records, followed by integrity and foreign-key checks.

Lock holders use independent processes. One test schedules their release from
the writer's event loop to verify that the new recovery yields instead of
blocking that timer. Each test creates its own database and holder.

CI runs the full suite on Node 22.19.0 / Linux, then packs that validated runtime.
Additional Node 24/26 Linux and Node 24 macOS jobs reuse the tarball for the
compatibility subset and this SQLite suite. The minimum-version environment
is not repeated in the matrix. Bun's `node:sqlite` compatibility implementation
is not used as a substitute for Node's SQLite driver.

## Follow-up boundary

The current lock selects Desktop 3.17.1 / runtime 0.17.1. Rebuild with
`sync:locked` before release validation; `sync:local` records a local App source
and does not establish the locked installer's provenance. The regressions do
not establish that every production workload is free of contention. Keep #162
open for validation on the reported workload. On recovery exhaustion, the error
includes `operation`, `attempts`, `elapsedMs` and the original SQLite cause;
use those fields to identify the next persistence boundary needing investigation.
Synchronous journal writes, non-idempotent counter operations, larger transactions
and cross-process fairness remain separate follow-up areas. Per-session databases
or a shared writer service require lifecycle and migration design.
