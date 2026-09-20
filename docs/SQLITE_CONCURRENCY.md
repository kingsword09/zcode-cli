# SQLite contention regression (#162 / #163)

The CLI's shared session database uses SQLite WAL. Readers can overlap a writer,
but different CLI processes still serialize writes to this file. After successful
store initialization, each connection now waits up to 10 seconds for a write lock.
Both the synchronous constructor and asynchronous `openStartup()` path apply this
setting **after** migrations finish. Startup migration lock budgets, short busy
waits, backoff, rollback, and failure cleanup are unchanged.

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
- a deliberately shortened timeout that reports `SQLITE_BUSY`, writes no session,
  and permits a later write after the lock is released;
- four independent processes migrating the same fresh database and persisting
  distinct sessions without duplicate migrations or integrity errors;
- killing a writer with uncommitted changes, then reopening without those changes
  and successfully writing another session.

The hold-and-release test needs a separate process: `DatabaseSync` blocks the
calling event loop, so a timer in that same process cannot release the lock.
Each test creates its own database and holder rather than reusing the remainder
of a lock window from a previous measurement.

CI builds and packs once, then tests that exact artifact on Node 22.19.0, 24, and
26 on Linux, plus Node 24 on macOS. Bun's `node:sqlite` compatibility implementation
is not used as a substitute for Node's SQLite driver.

## Follow-up boundary

If real workloads still exceed the wait budget, investigate long transactions and
add bounded retries only at persistence boundaries that can be safely rolled back
and replayed. Never retry a whole agent turn and repeat completed external tools.
Per-session databases or a shared writer service are separate architectural changes
requiring discovery, lifecycle, and migration design. The contention regression
tests also pass against the locked Desktop 3.14.0 runtime. They do not establish
that sustained high-concurrency workloads are free of contention.
