# Headless execution

`zcode -p 'task'` runs without a TUI. It is a foreground command, not a daemon,
and headless mode is separate from the browser's `--browser-use=headless` setting.

## Long-running jobs

- The prompt lifecycle keeps the Node event loop alive until prompt work and
  cleanup finish, including waits that otherwise have only unreferenced timers.
  This keepalive is not a task timeout or progress heartbeat.
- The launcher adds no overall job deadline. Model, tool, network, workflow and
  cleanup policies still apply. Use a host supervisor for an overall deadline;
  model retry settings are not a job timeout.
- Text and JSON output normally arrive at completion. For observable progress,
  use `--output-format stream-json` and consume the JSONL stream incrementally.
  A quiet interval during a tool call or retry is not by itself a failure.
- Consume stdout **and** stderr. Completion waits for queued writes to reach
  their consumers rather than allowing the runtime's exit watchdog to discard
  them. If a consumer stops reading, completion can wait until it resumes or
  the job is cancelled. This does not guarantee the consumer has persisted data.
- With `stream-json`, require both exit status 0 and a terminal `result` record.
  A missing result is incomplete even if the process reports status 0.

On POSIX systems, `SIGINT`, `SIGTERM` and `SIGHUP` are forwarded to the runtime
until it actually exits, including repeated signals during cleanup. Cancellation
must not be interpreted as success; conventional exit statuses are 130, 143
and 129 respectively. `SIGKILL` cannot run cleanup.

Headless mode does not make terminal logout safe automatically. Use a service
manager or explicitly detach a job if it must survive the shell/SSH connection:

```sh
nohup zcode -p 'your task' --output-format stream-json \
  >run.jsonl 2>run.stderr </dev/null &
```

Record the PID and exit status in your supervisor if you need reliable
cancellation and completion tracking. Configure permissions deliberately;
headless execution does not provide the TUI's interactive approval experience.

## macOS keychain over SSH

Headless mode does not require a separate credential secret when the macOS
keychain is available. If credential access fails because the keychain requires
user interaction, the CLI pauses that credential operation and runs the system
`security unlock-keychain` tool in the controlling terminal. Enter the keychain
password at its hidden prompt. After a successful unlock, the same process
retries the pending credential operation and continues; restarting the CLI or
logging in again is not required. Existing credentials and encryption keys are
not replaced, and completed tasks or tool calls are not replayed.

Use an interactive SSH terminal (`ssh -t user@host`) for this flow. The password
is handled by the system tool, not passed in arguments or environment variables,
and prompts go to `/dev/tty`, not task stdin or JSON/JSONL stdout. Concurrent
credential requests share one unlock attempt. A failed unlock or persistent
keychain item access-control failure stops the operation rather than prompting
indefinitely. With a raw-mode terminal UI, unlock in a separate terminal and
retry the operation in the existing session instead.

Without a controlling terminal (for example, an unattended service), the CLI
cannot prompt. Unlock the keychain in an appropriate interactive session or
configure a stable `ZCODE_CREDENTIAL_SECRET_FILE` before login. Changing secret
sources does not decrypt or migrate existing `enc:v2:os:` credentials; keep the
original keychain accessible or use a separate data directory and log in again.

## Regression coverage and limits

Local HTTP fixtures and real Node child processes exercise:

- Connection-reset recovery, incomplete SSE recovery and exhausted recovery.
- HTTP 503 retry backoff without a test-only keepalive preload.
- A 512 KiB answer in text, JSON and stream-JSON, including a consumer that
  delays reading for 10 seconds; stream-JSON also has a normal-reader control.
- `-p` cancellation during retry backoff and repeated launcher termination signals.
- Unreferenced pending work, success/failure handle cleanup and output-write errors.

The slow-reader case previously reproduced exit status 0 without the final result.
The repeated-signal case previously left the runtime alive after its launcher exited.
The lifecycle wrapper and launcher signal forwarding address those failures.

These are bounded regression tests, not an hours-long soak test. They do not
establish a fixed memory ceiling or cover every plugin, MCP server, background
workflow or real provider outage. Streaming output does not imply constant-memory
execution: the native runtime still retains turn events and the final answer.
For unattended production jobs, monitor process memory, disk space and progress,
and keep resumable session state rather than relying only on captured stdout.
