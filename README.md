# Agent Swarm Protocol CLI

A local general-purpose agent runtime with a custom **Agent Swarm Protocol (ASP)**
envelope-based communication layer. Think of it as a multi-agent orchestration
engine that runs entirely on your machine — planner, workers, reviewers, and
aggregators collaborate over typed IPC messages to decompose, execute, review,
and aggregate complex tasks.

## Quick start

```bash
# Prerequisites: Node.js >= 24
node --version

# Install globally
git clone <repo-url> && cd agent-swarm-cli
npm install
npm run build
npm install -g .

# Configure
swarm onboard          # interactive setup (provider, model, API key)
# or manually:
swarm auth set-key openai sk-...
swarm models set --planner kimi-coding/kimi-for-coding --worker kimi-coding/kimi-for-coding --aggregator kimi-coding/kimi-for-coding

# Launch the TUI
swarm

# Or run one objective headlessly
swarm run "read this repo and summarize the main runtime"
```

## CLI

```
swarm [--debug] [--debug-trace]

Commands:
  chat       Open the interactive swarm TUI (default)
  run        Run one objective non-interactively; auto mode defaults to the local coding loop
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  serve      Start the local Swarm Gateway HTTP/event-stream server
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List built-in model providers
  models     Show or update selected models

Built-in provider presets include OpenAI, Anthropic, Gemini, OpenRouter,
DeepSeek, Moonshot, Kimi Coding Plan, local OpenAI-compatible endpoints, and
custom OpenAI-compatible or Claude-compatible endpoints.

Execution modes:

| Mode | Purpose |
|------|---------|
| `auto` | Default. Uses a structured LLM route decision; prefer the local coding loop unless the task has justified parallel or multi-agent value. |
| `coding_loop` | Single main Swarm loop for repo reading, editing, commands, tests, and final answer. |
| `chat` | Answer without inspecting or modifying the workspace. |
| `full_swarm` | Experimental ASP planner/worker/reviewer/aggregator pipeline. |

Debug:
  --debug, --verbose, -v    Write JSON-line debug logs to ~/.swarm/logs/
  --debug-trace             Same but with trace-level detail
```

Useful TUI controls:

| Command | Purpose |
|---------|---------|
| `/kernel [workflow_path]` | Unified Swarm, Work Kernel, and Symphony status view |
| `/status` | Alias for the current kernel status view |
| `/work-items [workflow_path]` | Inspect local Symphony active and terminal work items |
| `/session [session_id]` | Inspect a persisted Work Kernel session snapshot |
| `/resume [session_id] [message]` | Resume an existing session; if the first token is not a known session, resume the latest session with the whole message |
| `/continue [message]` | Continue the latest local coding-loop session |
| `/attempts [session_id]` | Inspect Work Kernel run attempts, failures, workspace, and recovery hints |
| `/leases [session_id\|lease_id]` | Inspect Work Kernel workspace leases and write boundaries |
| `/doctor [workflow_path]` | Diagnose model setup, permissions, Kernel stores, and Symphony preflight |
| `/why` | Explain recent routing, delegation, review, and verification decisions |
| `/workers` | Inspect local worker agents |
| `/symphony [workflow_path]` | Inspect local Symphony scheduler/session status |
| `/symphony-tick [workflow_path] [--max-turns N]` | Dispatch one local Symphony scheduler tick from the TUI |
| `/symphony-run-once [workflow_path] [--max-turns N]` | Dispatch and execute one local Symphony scheduler tick from the TUI |
| `/symphony-start [workflow_path] [--execute]` | Start a local Symphony polling loop inside the TUI runtime |
| `/symphony-daemon [daemon_id]` | Inspect local TUI-managed Symphony daemon records |
| `/symphony-stop [daemon_id|all] [--cancel-running]` | Stop local TUI-managed Symphony daemon loops |
| `/symphony-cleanup [workflow_path] [--execute]` | Dry-run or execute terminal workspace cleanup |

When idle, the TUI main pane acts as the Kernel operator surface without showing
every record at once. Ctrl+N/Ctrl+P switches between focused panes: Overview,
Output, Sessions, Attempts, Agents, and Blackboard. Overview keeps the prompt
surface quiet; the other panes expose the fuller local state when needed. The
header and Kernel overview show the latest actual route selected by auto mode,
such as `coding_loop` or `full_swarm`, with confidence and the router reason.

The TUI creates a local Work Kernel session for the current chat state. Slash
tool approvals and tool results are recorded against that session, so `/session`,
`/attempts`, `/approvals`, `/audit`, and `/usage` can inspect TUI-local work
instead of showing detached tool events.

While work is running, the TUI keeps a stable current-action row plus a short
activity timeline. This makes long local coding-loop runs easier to follow:
thinking turns, read-only tool batches, individual tools, approval waits, and
turn completion stay visible without opening the full trace.

Modal views own their keyboard input. Approval and detail views consume
Escape/Ctrl+C/Ctrl+O before global shortcuts, so closing an overlay does not
accidentally interrupt active work or change the underlying pane.

The input line supports command history with Up/Down while preserving the
current unsent draft, cursor movement with Left/Right, Ctrl+A/Ctrl+E for line
bounds, Ctrl+U to kill the draft before the cursor, Ctrl+K to kill to the line
end, Ctrl+W to kill the previous word, Ctrl+Y to yank the last killed text, and
robust Backspace/Delete handling across common terminal encodings. Enter submits
the draft; Ctrl+J or Alt+Enter inserts a newline, and pasted multi-line text is
kept inside the draft instead of submitting partial prompts. Typing `/` shows
slash command candidates; Up/Down moves the highlighted candidate, Tab accepts
it, and Esc closes the candidate list. Slash command results render an inline
preview in the TUI; Ctrl+O remains the full detail view for long output, with
the same preview in the TUI kept visible during normal chat. Recent slash tool
output is also visible in the Output pane. Large slash tool output is saved
under the local session output store and shown as a preview plus a full-output
path.

The input prompt is rendered by Ink from local input state rather than by a
manual stdout repaint loop. This keeps deletion and cursor movement predictable
and prevents the main dashboard from being redrawn by every byte typed.

## Local Gateway

The CLI TUI is the only product interface. `swarm serve` starts a local
HTTP/event-stream API for scripts, editor integrations, and debugging. It defaults to
`http://127.0.0.1:38171`.

```bash
swarm serve
swarm serve --port 0
```

The `/` route returns a JSON API index. It is not a product interface;
user-facing workflows live in the CLI/TUI.

Core endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/sessions` | Start a run with `{ "objective": "...", "mode": "auto" }` |
| `GET /v1/sessions` | List recent sessions |
| `GET /v1/sessions/:id` | Inspect session, plan, task graph, and usage summary |
| `GET /v1/sessions/:id/events` | Stream runtime events as Server-Sent Events |
| `POST /v1/sessions/:id/messages` | Send live user input to the main Swarm |
| `POST /v1/sessions/:id/interrupt` | Ask the main Swarm to interrupt/reassess |
| `GET /v1/sessions/:id/graph` | Read the persisted task graph |
| `GET /v1/sessions/:id/trace` | Read persisted envelopes |
| `GET /v1/sessions/:id/audit` | Read approval/tool/runtime audit records |
| `GET /v1/sessions/:id/usage` | Read usage events and counters |
| `GET /v1/approvals` | List stored and currently pending approvals |
| `POST /v1/approvals/:id/decision` | Continue a pending approval with approve/deny |
| `GET /v1/symphony/status` | Read local Symphony scheduler/session status |
| `POST /v1/symphony/tick` | Run one local Symphony scheduler tick |
| `POST /v1/symphony/run-once` | Dispatch and execute local Symphony work once |
| `GET /v1/symphony/daemon` | List local Gateway-managed Symphony daemons |
| `POST /v1/symphony/daemon/start` | Start a local Symphony polling loop |
| `POST /v1/symphony/daemon/stop` | Stop one or all local Symphony polling loops |
| `POST /v1/symphony/cleanup` | Dry-run or execute terminal workspace cleanup |

## Architecture

```
User Request
    │
    ▼
Swarm TUI / headless CLI / Gateway API
    │
    ▼
Orchestrator (Coordinator)
  ├── PlanGenerator ──► decompose objective into SwarmTask[]
  ├── EnvelopeRouter ──► route typed IPC messages to agents by capability
  ├── Reviewer ──► quality gate with approval/needs_revision/reject verdicts
  └── Aggregator ──► synthesize blackboard entries into a final answer
    │
    ▼
Agent Processes (node:child_process.fork)
  ├── Planner   (LLM-backed task decomposition)
  ├── Worker    (LLM-backed execution with tool access)
  ├── Tool      (file I/O, shell, git, web, code, package, solidity)
  ├── Reviewer  (LLM-backed quality assessment)
  └── Aggregator (LLM-backed result synthesis)
    │
    ▼
Shared State (SQLite)
  ├── BlackboardStore ── plan / evidence / result / critique / decision / artifact
  ├── SessionStore ──── session lifecycle tracking
  ├── ArtifactStore ─── final output artifacts
  └── TraceStore ────── execution traces
```

## Protocol layers

| Layer | Name | Role |
|-------|------|------|
| L4 | Swarm Task Protocol | Task decomposition, assignment, aggregation, termination |
| L3 | Coordination Protocol | Status sync, review, error recovery |
| L2 | Envelope Protocol | Typed message metadata, routing, correlation, TTL |
| L1 | Transport Protocol | `node:child_process.fork()` IPC via `process.send()` |

## Built-in tools (19 tool actions)

| Category | Tool | Capability |
|----------|------|------------|
| Files | list, read, write, edit, stat, glob, grep | `tool.file.*` |
| Shell | exec | `tool.shell.exec` |
| Web | search, fetch | `web.search`, `web.fetch` |
| Code | test, lint | `code.test`, `code.lint` |
| Git | status, diff, log, branch | `git.*` |
| Package | install | `package.install` |
| Solidity | compile | `solidity.compile` |
| Agent | delegate | `agent.delegate` |

Tool approval is driven by `~/.swarm/settings.json` permission rules. High-risk
actions such as shell, package install, delegate, write/edit, web fetch, and
branch mutation are held until the user confirms in the TUI unless the active
permission mode allows them. The approval view shows why the tool is needed,
predicted impact, rollback guidance, target details, and optional diff context.
Use `y`/`a` to allow once, `s` to allow the same action and target for the
current TUI session, or `n`/`d` to deny.

## Agent capabilities

Capabilities use a hierarchical `domain.action` naming convention:

```
web.search    web.fetch
code.review   code.test    code.lint    code.inspect
git.status    git.diff     git.log      git.branch
solidity.compile   solidity.audit
package.install
agent.delegate
tool.file.*   tool.shell.exec
credential.exfiltrate   (forbidden by default)
```

## Error recovery

Agent failures carry a `recovery_suggestion`:

| Strategy | Behavior |
|----------|----------|
| `retry_same_agent` | Retry the same agent (up to `policy.retry.max_attempts`) |
| `retry_different_agent` | Try a different capability from `required_capabilities` |
| `ask_human` | Interrupt execution and prompt the user in TUI |
| `abort_swarm` | Cancel the session immediately |

## Review feedback loop

```
task.result → review.request → review.result
    │                              │
    │  ◄── needs_revision ────────┘  (re-run task_id-linked tasks with feedback)
    │  ◄── reject ─────────────────  (re-run task_id-linked tasks, or all tasks)
    │  ◄── approve ────────────────► aggregate → final artifact
```

Double-reject after re-run aborts the session.

## Debug logging

Enable with `swarm --debug` or `SWARM_DEBUG=1`. JSON-line logs are written per
chat session to `~/.swarm/logs/<session-id>.log`. When a log exceeds 1MB it
rolls to `<session-id>.part-N.log`. Each entry includes timestamp, PID,
session id, level, section, message, and optional data.

Set `SWARM_DEBUG_LEVEL=trace` (or use `--debug-trace`) for envelope payload
dumps and operation timings.

## Configuration

All state lives under `~/.swarm/` (override with `SWARM_HOME`):

```
~/.swarm/
  config.json         provider API keys (plaintext)
  settings.json       model selection, runtime settings, provider definitions
  state/
    swarm.db          sessions, blackboard, artifacts, and traces
  logs/               debug log files (when --debug)
```

### Key environment variables

| Variable | Purpose |
|----------|---------|
| `SWARM_HOME` | Override `~/.swarm` directory |
| `SWARM_DEBUG` | Enable debug logging (`1`, `true`, or `verbose`) |
| `SWARM_DEBUG_LEVEL` | Log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `SWARM_MODEL` | Override planner model |
| `SWARM_WORKER_MODEL` | Override worker model |
| `SWARM_AGGREGATOR_MODEL` | Override aggregator model |
| `SWARM_TASK_TIMEOUT_MS` | Per-task timeout in ms |
| `OPENAI_API_KEY` | Environment key source for the openai provider |

## Development

```bash
npm run check     # TypeScript compilation check (no emit)
npm run build     # Compile to dist/
npm run smoke     # Build + end-to-end smoke test
```

Requires Node.js >= 24 and TypeScript 5.9+.

## License

AGPL-3.0 — see [LICENSE](./LICENSE).
