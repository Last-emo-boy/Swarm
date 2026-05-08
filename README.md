# Swarm

Swarm is a local coding agent runtime with one user-facing entrypoint: the CLI
TUI. Users talk to the main Swarm; Swarm decides whether to answer directly, run
the local coding loop, delegate work, review changes, resume memory, or use
extensions.

The product bias is simple: finish useful workspace work, show the result first,
and keep the internal Work Kernel, ASP protocol, workers, Gateway, and Symphony
surfaces available only when they help.

## What It Does

| Area | Current behavior |
| --- | --- |
| Main entry | `swarm` opens the interactive TUI by default. |
| Result-first UX | Normal runs now finish with a result card before raw output. |
| Local coding | Reads, edits, runs shell/test/lint/build/git tools, and verifies results. |
| Memory | Sessions keep compacted context and require freshness checks on resume. |
| Delegation | The main Swarm owns worker spawning, continuation, stop, and handoff. |
| Extensions | Built-in tools, MCP, skills, slash commands, agent specs, and plugins share one capability plane. |
| Automation | Gateway and Symphony are local automation entrypoints, not separate product UIs. |

## Quick Start

```bash
# Requirements
node --version   # Node.js >= 24

# Install from this repo
git clone <repo-url>
cd Swarm
npm install
npm run build
npm install -g .

# Configure provider/model/API key in the TUI
swarm onboard

# Start the product UI
swarm
```

Manual configuration is also available:

```bash
swarm auth set-key openai sk-...
swarm models set \
  --planner kimi-coding/kimi-for-coding \
  --worker kimi-coding/kimi-for-coding \
  --aggregator kimi-coding/kimi-for-coding
```

Run one objective without the TUI:

```bash
swarm run "read this repo and summarize the main runtime"
```

## Golden Path

1. Run `swarm` in a project directory.
2. Type a natural-language objective.
3. Approve risky tools when Swarm asks.
4. Watch the current action and short activity timeline.
5. Read the final result card: status, changed files, checks, review, and memory freshness.
6. Continue later with `/continue`, `/resume`, or `/memory`.

Swarm is not a report generator by default. For coding and project work, the
final product is real workspace changes. Long logs, worker drafts, trace
snapshots, and large tool outputs are stored under local Swarm state instead of
flooding the chat.

## CLI

```text
swarm [--debug] [--debug-trace] [--yolo]

Commands:
  chat       Open the interactive Swarm TUI (default)
  run        Run one objective non-interactively
  yolo       Open chat with temporary yolo permissions for this process
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  serve      Start the local Swarm Gateway HTTP/event-stream server
  symphony   Run local work-source automation commands
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List or add model providers
  models     Show or update selected models
  version    Print the installed Swarm version

Run modes:
  auto         Default. Structured route decision; usually starts with coding_loop.
  coding_loop  Main Swarm read/edit/command/test loop.
  chat         Answer without inspecting or modifying the workspace.
  full_swarm   Experimental ASP planner/worker/reviewer/aggregator path.
```

Provider presets currently include OpenAI, Anthropic, Gemini, OpenRouter,
DeepSeek, xAI, Groq, Cerebras, Together AI, Fireworks, Moonshot, Kimi Coding
Plan, Mistral, SiliconFlow, DashScope, Requesty, Helicone, Ollama, LM Studio,
vLLM, LocalAI, and custom OpenAI-compatible or Claude-compatible endpoints.

Headless runs can emit machine-readable artifacts:

```bash
swarm run --mode auto --json --report report.json "fix the failing tests"
swarm run --telemetry telemetry.json --trajectory trajectory.json "inspect this repo"
```

`--trajectory` writes an ATIF-v1.7 style trajectory for benchmark harnesses.
`--telemetry` writes Swarm runtime telemetry.

## TUI

The CLI TUI is the only product interface. Headless CLI, Gateway, and Symphony
paths are execution or automation entrypoints.

### Main Controls

| Command | Purpose |
| --- | --- |
| `/help` | Show main-path commands only. |
| `/help all` | Show advanced diagnostics, Symphony, agents, tools, and extension controls. |
| `/doctor [workflow_path]` | Diagnose model setup, permissions, Kernel stores, and Symphony preflight. |
| `/mode [auto\|fast\|swarm\|chat]` | Show or change routing mode. |
| `/why` | Explain recent routing, delegation, review, and verification decisions. |
| `/session [session_id]` | Inspect a persisted Work Kernel session snapshot. |
| `/memory [session_id]` | Show remembered session context and the freshness checks used before resume. |
| `/resume [session_id] [message]` | Resume a previous session. |
| `/continue [message]` | Continue the latest local coding-loop session. |
| `/kernel [workflow_path]` | Show the unified Swarm, Work Kernel, and Symphony status view. |
| `/status` | Alias for the current Kernel status view. |
| `/attempts [session_id]` | Inspect Work Kernel run attempts, failures, workspace, and recovery hints. |
| `/leases [session_id\|lease_id]` | Inspect Work Kernel workspace leases and write boundaries. |
| `/work-items [workflow_path]` | Inspect local Symphony active and terminal work items. |
| `/symphony [workflow_path]` | Inspect local Symphony scheduler/session status. |
| `/symphony-run-once [workflow_path] [--max-turns N]` | Dispatch and execute one Symphony tick from the TUI. |

By default `/help` and slash completion only surface the main path. Use `/help
all` to show the full advanced catalog. Capability and extension surfaces also
start with summaries; use `/capabilities all`, `/skills all`, `/plugins all`, or
`/mcp all` for the full advanced catalog.

Common advanced controls include `/self-review`, `/improve-self`, `/evals`,
`/read`, `/grep`, `/glob`, `/shell`, `/web`, `/diff`, `/output`, `/workers`,
`/handoffs`, `/approvals`, `/audit`, `/usage`, `/symphony-tick`,
`/symphony-daemon`, `/symphony-start`, `/symphony-stop`,
`/symphony-cleanup`, `/capability-enable`, `/capability-disable`,
`/plugin-install`, `/plugin-enable`, `/plugin-disable`, `/skill`,
`/mcp-refresh`, `/mcp-resources`, `/mcp-read`, `/mcp-prompts`, and
`/mcp-prompt`.

### Result Card

Normal runs now finish with a result card before the raw assistant output. The
card shows:

- session id and completion status;
- changed files;
- checks and verification signals;
- review summary;
- memory freshness note;
- artifact path when long output is persisted.

`/session <session_id>` starts with the same result card before deeper Kernel
records. `/memory [session_id]` shows the remembered context plus the same
freshness contract Swarm injects before resume, making stale session memory
visible instead of silently trusted.

### Layout

When idle, the TUI main pane acts as the Kernel operator surface without showing
every record at once. Ctrl+N/Ctrl+P switches between focused panes: Overview,
Output, Sessions, Attempts, Activity, and Blackboard. Overview keeps the prompt
surface quiet; the Activity pane summarizes workers, approvals, and background
work without making agent internals the default view. The other panes expose the
fuller local state when needed. The header and Kernel overview show the latest actual route selected by auto mode, such as `coding_loop` or `full_swarm`, with confidence and the router reason.

The TUI creates a local Work Kernel session for the current chat state. Slash
tool approvals and tool results are recorded against that session, so `/session`,
`/attempts`, `/approvals`, `/audit`, and `/usage` can inspect TUI-local work
instead of showing detached tool events.

While work is running, the TUI keeps a stable current-action row plus a short
activity timeline. Thinking turns, read-only tool batches, individual tools,
approval waits, and turn completion stay visible without opening the full trace.

### Input

The input line supports command history with Up/Down while preserving the
current unsent draft. It supports cursor movement with Left/Right,
Ctrl+A/Ctrl+E for line bounds, Ctrl+U to kill the draft before the cursor,
Ctrl+K to kill to the line end, Ctrl+W to kill the previous word, Ctrl+Y to yank
the last killed text, and robust Backspace/Delete handling across common
terminal encodings.

Enter submits the draft. Ctrl+J or Alt+Enter inserts a newline. Pasted
multi-line text stays inside the draft instead of submitting partial prompts.
Typing `/` shows slash command candidates; Up/Down moves the highlighted
candidate, Tab accepts it, and Esc closes the candidate list.

Slash command results render a preview in the TUI. Ctrl+O opens the full detail
view for long output, and recent slash tool output is visible in the Output pane.
Large slash tool output is saved under the local session output store and shown
as a preview plus a full-output path.

Modal views own their keyboard input. Approval and detail views consume
Escape/Ctrl+C/Ctrl+O before global shortcuts, so closing an overlay does not
interrupt active work or change the underlying pane.

The input prompt is rendered by Ink from local input state rather than by a
manual stdout repaint loop. This keeps deletion and cursor movement predictable
and prevents the main dashboard from being redrawn by every byte typed.

## Capabilities And Extensions

Swarm's extension capability plane unifies built-in tools, MCP servers, Agent
Skills, slash commands, agent specs, and future plugins behind the same Gateway,
TUI, permission, audit, and Work Kernel records. See
`docs/EXTENSION_CAPABILITY_PLANE.md`.

Capability and extension surfaces also start with summaries. Gateway catalog
endpoints return raw records plus a shared `summary` object for capabilities,
skills, plugins, and MCP servers so integrations can show the same summary-first
surface as the TUI.

### Built-In Tool Families

| Family | Examples |
| --- | --- |
| Files | `file.read`, `file.list`, `file.glob`, `file.grep`, `file.stat`, `file.resolve`, `file.write`, `file.edit`, `file.patch`, `file.mkdir`, `file.move`, `file.copy`, `file.delete` |
| JSON and notebooks | `json.read`, `json.edit`, `notebook.edit` |
| Tasks and memory | `todo.write`, `blackboard.write`, `blackboard.search`, `blackboard.read`, `blackboard.list` |
| Shell and processes | `shell.exec`, `exec`, `process.start`, `process.status`, `process.list`, `process.tail`, `process.grep`, `process.stop` |
| Web | `web.search`, `web.fetch` |
| Code | `code.test`, `code.lint`, `code.build` |
| Git | `git.status`, `git.diff`, `git.log`, `git.branch`, `git.show` |
| Packages and projects | `package.install`, `package.info`, `project.detect` |
| Agents | `agent.delegate` |

Model-visible tools use generic coding names, while compatibility aliases and
advanced capabilities remain discoverable through the capability catalog.

## Safety And Permissions

Tool approval is driven by `~/.swarm/settings.json` permission rules. High-risk
actions such as shell, package install, delegate, write/edit, web fetch, and
branch mutation are held until the user confirms in the TUI unless the active
permission mode allows them.

The approval view shows why the tool is needed, predicted impact, rollback
guidance, target details, and optional diff context. Use `y` or `a` to allow
once, `s` to allow the same action and target for the current TUI session, or
`n` or `d` to deny.

Permission modes:

| Mode | Behavior |
| --- | --- |
| `ask` | Ask before risky actions. |
| `auto-edit` | Allow lower-risk edits but keep risky operations gated. |
| `full-auto` | Reduce prompts while preserving deny rules. |
| `yolo` | Temporary opt-in mode for skipping approval prompts while preserving workspace and deny-list boundaries. |

Deny rules override allow rules and yolo mode.

## Local Gateway

`swarm serve` starts a local HTTP/event-stream API for scripts, editor
integrations, and debugging. It defaults to `http://127.0.0.1:38171`.

```bash
swarm serve
swarm serve --port 0
```

The `/` route returns a JSON API index. It is not a product interface;
user-facing workflows live in the CLI/TUI.

`/health` returns the current public route list from the running Gateway.
Important endpoint groups:

| Group | Routes |
| --- | --- |
| Runs and sessions | `POST /v1/sessions`, `GET /v1/runs`, `GET /v1/events`, `GET /v1/sessions/:id/events` |
| Live control | `POST /v1/sessions/:id/messages`, `POST /v1/sessions/:id/interrupt`, `POST /v1/sessions/:id/execute`, `POST /v1/sessions/:id/fork` |
| Kernel inspection | `GET /v1/sessions/:id/graph`, `/tasks/:task_id`, `/trace`, `/blackboard`, `/approvals`, `/audit`, `/usage` |
| Collaboration | `GET /v1/workers`, `POST /v1/workers/:id/stop`, `GET /v1/handoffs`, `POST /v1/handoffs/:id/take-back` |
| Capabilities | `GET /v1/capabilities`, `POST /v1/capabilities/:id/invoke`, enable/disable/show/hide, refresh |
| Extensions | `GET /v1/skills`, `POST /v1/skills/:name/activate`, `GET /v1/plugins`, plugin install/update/remove/enable/disable |
| MCP | `GET /v1/mcp/servers`, server refresh, resource list/read, prompt list/get |
| Symphony | `GET /v1/symphony/status`, preview, tick, run-once, cleanup, daemon start/stop |

## Symphony

Symphony is the background work intake and scheduler. It reads local work items,
creates per-item workspaces, and runs the same Work Kernel runner used by the
TUI.

```bash
swarm symphony preview --workflow WORKFLOW.md
swarm symphony tick --workflow WORKFLOW.md
swarm symphony run-once --workflow WORKFLOW.md --max-turns 12
swarm symphony status --workflow WORKFLOW.md --max-ticks 20
swarm symphony daemon --workflow WORKFLOW.md --execute --max-ticks 3
swarm symphony cleanup --workflow WORKFLOW.md --execute
```

Symphony writes sessions, attempts, workspace leases, blackboard records, audit,
usage, and final outcomes into the same local Work Kernel stores. It does not
own a separate planner, blackboard, review system, or product UI.

## Architecture

```text
Human or automation request
  -> Swarm TUI, headless CLI, Gateway, or Symphony
  -> Work Kernel
  -> capability broker and local tools
  -> coding loop, workers, review, verification
  -> result card, artifacts, trace, memory
```

Key layers:

| Layer | Role |
| --- | --- |
| Swarm TUI | Product interaction surface and main Swarm conversation. |
| Work Kernel | Shared execution truth: sessions, attempts, leases, graph, blackboard, artifacts, approvals, audit, usage, review, final outcome. |
| Capability Plane | Shared catalog and broker for built-ins, MCP, skills, slash commands, agent specs, and plugins. |
| ASP | Envelope, routing, task graph, blackboard, review, consensus, and policy contracts. |
| Symphony | Local background intake over repository-owned work sources. |
| Gateway | Local API and SSE surface for automation and integrations. |

The older Agent Swarm Protocol architecture is still present for full-swarm and
protocol experiments, but the default product path is the local coding loop with
main-Swarm-owned delegation.

## Memory And Recovery

WorkSession memory records recent turns, worker results, tool results, workspace
changes, review output, verification, and final outcomes. Older entries are
compacted into extractive summaries while preserving a recent tail.

On resume, Swarm injects a freshness contract:

- treat prior task packets, compacted memory, and worker results as historical
  clues, not current facts;
- refresh current files with read/search/git tools before editing or making a
  code-state claim;
- follow the current workspace if it differs from memory.

`/memory [session_id]` is the user-facing view over that same contract.

## Debugging

Enable debug logs with:

```bash
swarm --debug
swarm --debug-trace
```

Or set environment variables:

```bash
SWARM_DEBUG=1
SWARM_DEBUG_LEVEL=trace
```

JSON-line logs are written per chat session to `~/.swarm/logs/<session-id>.log`.
When a log exceeds 1 MB it rolls to `<session-id>.part-N.log`. Each entry
includes timestamp, PID, session id, level, section, message, and optional data.

## Configuration

All state lives under `~/.swarm/` by default. Override it with `SWARM_HOME`.

```text
~/.swarm/
  config.json         provider API keys (plaintext)
  settings.json       model selection, runtime settings, provider definitions
  state/
    swarm.db          sessions, blackboard, artifacts, traces, usage, memory
  logs/               debug log files
```

Key environment variables:

| Variable | Purpose |
| --- | --- |
| `SWARM_HOME` | Override `~/.swarm` directory. |
| `SWARM_DEBUG` | Enable debug logging (`1`, `true`, or `verbose`). |
| `SWARM_DEBUG_LEVEL` | Log level (`trace`, `debug`, `info`, `warn`, `error`). |
| `SWARM_PERMISSION_MODE` | Override permissions: `ask`, `auto-edit`, `full-auto`, `yolo`. |
| `SWARM_MODEL` | Override planner/default model. |
| `SWARM_WORKER_MODEL` | Override worker model. |
| `SWARM_AGGREGATOR_MODEL` | Override aggregator model. |
| `SWARM_MAX_OUTPUT_TOKENS` | Override per-response output token cap, clamped to 128000. |
| `SWARM_DISABLE_PROMPT_CACHING` | Disable provider prompt-cache hints and cache-control markers. |
| `SWARM_PROMPT_CACHE_TTL` | Set Anthropic cache TTL hint; use `1h` for one-hour cache blocks. |
| `SWARM_PROMPT_CACHE_RETENTION` | Set OpenAI prompt cache retention; use `24h` when supported. |
| `SWARM_GEMINI_CACHE_TTL_SECONDS` | TTL for Gemini explicit cachedContent entries. |
| `SWARM_TASK_TIMEOUT_MS` | Per-task timeout in ms. |
| `OPENAI_API_KEY` | Environment key source for the OpenAI provider. |

## Development

```bash
npm run check     # TypeScript compilation check, no emit
npm run build     # Compile to dist/
npm run evals     # Build and run local product regression evals
npm run smoke     # Build and run end-to-end smoke test
```

Package publishing/install uses the `files` allowlist in `package.json`, so
global installs include `dist/` and this README.

## Benchmark Wrapper

The `bench/harbor` wrapper can install a local Swarm package into an isolated
benchmark environment, forward model configuration via environment variables,
and upload report, telemetry, and trajectory artifacts.

## License

AGPL-3.0. See [LICENSE](./LICENSE).
