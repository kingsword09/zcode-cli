# Headless execution

`zcode -p 'task'` runs without a TUI. It is a foreground command, not a daemon,
and headless mode is separate from the browser's `--browser-use=headless` setting.

## Environment configuration for CI

Headless `--prompt` / `-p` invocations accept the following environment variables.
They do not configure the TUI, login, doctor, plugin commands or app-server.

| Variable | Meaning |
| --- | --- |
| `ZCODE_MODEL_BASE_URL` | Custom inference API root, including its API prefix, e.g. `https://gateway.example.com/v1` |
| `ZCODE_API_KEY` | API key for that custom endpoint |
| `ZCODE_API_TYPE` | `openai-chat-completions` (default), `openai-responses`, or `anthropic-messages` |
| `ZCODE_MODEL` | Raw server model ID with a custom endpoint; otherwise a saved `provider/model` selection |
| `ZCODE_EFFORT` | Reasoning effort for this run; explicit `--effort` takes precedence |

Blank variables are treated as unset. Specifying an endpoint, key or API type
activates custom-provider mode and requires an endpoint, key and model. `--model`
may supply the model instead of `ZCODE_MODEL`. In custom-provider mode it is a
raw server ID, not a saved provider selection, and `/` is preserved verbatim.
Without custom-provider mode, `--model` and `ZCODE_MODEL` require `provider/model`.
Explicit CLI model/effort flags take precedence over environment variables, which
take precedence over saved or resumed selections. Reapply the custom endpoint
environment when resuming a session created with it.

`ZCODE_BASE_URL` retains its existing ZCode account/control-service meaning. It is
not an alias for `ZCODE_MODEL_BASE_URL`. A custom model endpoint must be HTTP(S)
without embedded credentials, query parameters or fragments. Use HTTPS for remote
services. The endpoint must implement the selected protocol, including streaming
and tool calling for agent tasks; a compatible-looking URL alone is insufficient.

Custom-provider mode creates a private temporary provider file (directory mode
0700 and file mode 0600 on POSIX), containing only the supplied provider. It uses
the internal provider ID `cli-env` and does not overwrite the personal provider
file, saved default model or account credentials. The launcher removes its
temporary directory after success, failure or handled cancellation. `SIGKILL`,
runner failure or power loss cannot guarantee cleanup; prefer disposable runners
and do not archive temporary/runtime directories containing secrets. Normal
runtime session data may still be persisted; this is not an ephemeral-session or
secret-isolation feature.

With a custom endpoint, omitted effort or `auto` sends no explicit reasoning
parameters. Explicit effort uses the selected protocol's mapping:

- Chat Completions: `reasoning_effort`.
- Responses: `reasoning.effort`.
- Anthropic Messages: adaptive `thinking` with `output_config.effort`;
  `none` / `disabled` disables thinking instead.

The custom endpoint validates whether the model accepts that effort and mapping.
These are protocol presets, not automatic model capability discovery. Older
Anthropic models requiring token-budget thinking, gateway-specific mappings,
custom headers and model capability overrides should use the full
[provider configuration](PROVIDER_CONFIG.md) instead. Without custom-provider
mode, effort continues to use the saved provider's catalog and validation.
Invalid local configuration fails before starting the runtime. Provider errors
fail the job rather than falling back to an account or saved provider.

### GitHub Actions example

Create repository variables `AI_BASE_URL`, `AI_MODEL`, and optionally `AI_EFFORT`,
plus the secret `AI_API_KEY`. Add a trusted prompt at `.github/prompts/review.md`.
This minimal example runs only on manual dispatch, not arbitrary external PRs:

```yaml
name: ZCode task
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  task:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - name: Install CLI
        run: npm install -g zcode-app-cli
      - name: Run trusted task
        env:
          ZCODE_MODEL_BASE_URL: ${{ vars.AI_BASE_URL }}
          ZCODE_API_KEY: ${{ secrets.AI_API_KEY }}
          ZCODE_MODEL: ${{ vars.AI_MODEL }}
          ZCODE_EFFORT: ${{ vars.AI_EFFORT }}
          ZCODE_API_TYPE: openai-chat-completions
        shell: bash
        run: |
          set -euo pipefail
          zcode -p "$(cat .github/prompts/review.md)" \
            --mode build --disallowed-tools 'Bash Edit Write' \
            --output-format stream-json > "$RUNNER_TEMP/zcode-result.jsonl"
          jq -s -e 'any(.[]; .type == "result")' "$RUNNER_TEMP/zcode-result.jsonl" > /dev/null
```

Pin CLI versions and action commit SHAs according to your deployment policy.
This example restricts common shell/edit tools for an inspection task; it is not
an OS sandbox or a comprehensive allowlist. Approval-requiring operations cannot
rely on the TUI in CI. Use `yolo` only for trusted workloads on isolated runners.
Successful execution is not a quality gate by itself; parse the task's outcome
separately if findings should fail CI.

Pass keys only to the invocation/step that needs them, not a whole job containing
untrusted install/build scripts. Even step-scoped keys and private files can be
read by tools or repository-controlled code executed by the agent. Environment
configuration does not isolate credentials. Do not expose secrets to untrusted
forks or use `pull_request_target` to execute untrusted PR code. Review prompt
injection risks, project hooks, plugins and MCP configuration. Run GitHub writes
(comments/PR creation) separately with narrowly scoped GitHub credentials; those
credentials are distinct from the model API key. A GitHub App is not required
for this CLI-based integration.

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
