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
```

## CLI

```
swarm [--debug] [--debug-trace]

Commands:
  chat       Open the interactive swarm TUI (default)
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List built-in model providers
  models     Show or update selected models

Built-in provider presets include OpenAI, Anthropic, Gemini, OpenRouter,
DeepSeek, Moonshot, Kimi Coding Plan, local OpenAI-compatible endpoints, and
custom OpenAI-compatible or Claude-compatible endpoints.

Debug:
  --debug, --verbose, -v    Write JSON-line debug logs to ~/.swarm/logs/
  --debug-trace             Same but with trace-level detail
```

## Architecture

```
User Request
    │
    ▼
Swarm Gateway / TUI
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
permission mode allows them.

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
