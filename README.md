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
| Tickets | `swarm superagent` turns requests from GitHub, Feishu and the TUI into tickets; each runs in a background worker with its own directory and answers where it was asked. |

## Current Product Status

The release-readiness source of truth is the offline release gate
(`npm run release:gate`), which must pass without paid provider calls. An
implemented claim is only considered backed when it has both a source anchor and
a focused test anchor.

Current verified surface:

- CLI/TUI first local coding product with result cards, resume/memory checks,
  slash command operator surfaces, prompt-cache status, scoped-write/read-only
  policy, local LSP semantic helpers, and local Work Kernel inspection.
- Evidence-backed local Swarm v2 collaboration: actor identity, mailbox
  delivery, ownership leases, handoff transfer, blackboard claim/proposal/
  decision flow, Gateway/Symphony/LSP capability participants, protocol debug
  timeline, `/swarm` workbench projection, real swarm offline evals, and legacy
  direct-path migration audit are implemented and covered by focused local
  tests/evals.
- Local Gateway automation for runs, event streams, live approvals, sessions,
  workers, handoffs, capabilities, bounded checkpoint routes, and Symphony
  route smoke.
- Symphony local background intake over repository-owned work sources, including
  local/fake source parsing, scheduler recovery, daemon lifecycle, runner
  terminal bookkeeping, workflow loader failure handling, workspace boundary
  checks, shared CLI/Gateway/TUI status formatting, and cleanup.
- Local ASP protocol behavior: envelope idempotency, in-process router dispatch,
  blackboard write/read/update/lock/query handling, task/artifact/bid/consensus
  handling, reply correlation, and conservative execution-router fallback
  policy.
- Bounded child-process ASP transport behavior: child runtime envelopes enter
  the router, addressed replies return to child agents, task progress becomes
  loop activity, and local capability/idempotency replay edges are tested.

Still intentionally bounded:

- A bounded Gateway checkpoint route now lists, creates, and reverts checkpoints
  for the current server workspace through the existing runtime helpers.
  Broader checkpoint orchestration remains deferred: no session/run-scoped
  checkpoint API, distributed checkpoint transport, checkpoint storage redesign,
  or checkpoint event-stream expansion is a completed product claim.
- Broader distributed ASP transport is still planned: network/cross-host
  routing, a new distributed worker model, retry-different-worker health
  policy, and distributed trace are not completed product claims.
- Cross-host distributed network execution, complex consensus beyond the local
  protocol fixtures, and external provider dogfood remain deferred or optional;
  the default release gate does not require paid provider calls.
- Hook-race approval arbitration and rich WorkSource writes remain deferred.

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

`swarm update` later pulls the branch the clone tracks (fast-forward only), runs `npm install` and `npm run build`,
and restarts the node service when one runs; `swarm update --check` only says whether an update waits. It refuses a
clone with uncommitted changes, one on a branch that tracks no remote, and one with commits of its own, and says how
any other install (a copied package, a container image) is updated instead.

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
  work       Run one objective through the local coding_loop main path
  watch      Follow the live Gateway event stream for the current workspace
  runs       Inspect active and recent Gateway runs
  checkpoints
             List, create, and revert local workspace checkpoints
  sessions   List, inspect, resume, execute, and fork persisted WorkSessions
  workers    Inspect, watch, stop, and continue persisted worker contracts
  handoffs   Inspect, watch, and take back persisted handoff contracts
  approvals  Inspect approval records and answer live Gateway approval requests
  ps         Alias for `swarm sessions`
  doctor     Diagnose local model setup, stores, extensions, logs, and Symphony preflight
  logs       List recent debug logs or tail the latest matching log file
  capabilities
             List, inspect, refresh, toggle, and invoke capability-plane surfaces
  plugins    List, inspect, validate, and manage plugin roots and plugin enablement
  skills     List, inspect, and activate discovered Agent Skills
  mcp        List, inspect, refresh, and read configured MCP servers, resources, and prompts
  lsp        Inspect local Language Server Protocol providers and logs
  yolo       Open chat with temporary yolo permissions for this process
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  serve      Start the local Swarm Gateway HTTP/event-stream server
  symphony   Run local work-source automation commands
  superagent Run the ticket host and manage tickets from GitHub, Feishu and this terminal
  harness    List the agent harness profiles here: installed, signed in, keys set
  mesh       Pair this device with other Swarm devices and see them
  node       Run this device's node: the ticket host and the mesh server peers call; install it as a service
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List or add model providers
  models     Show or update selected models
  version    Print the installed Swarm version
  update     Pull, install and build a clone install, and restart its node service; --check only looks
  usage      What model calls and harness turns used and cost, by model, provider, harness, device, ticket or day

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
swarm work "fix the failing tests"
swarm run --stream-json "fix the failing tests"
swarm run --permission-mode full-auto "apply the mechanical rename"
swarm run --approval-mode wait "run the gated command and wait for approval"
swarm run --read-only --stream-json "audit the auth flow"
swarm run --add-dir ../shared --read-only "audit this repo and shared types"
swarm run --max-turns 3 --max-tool-calls 12 "make the smallest safe fix"
swarm run --allowed-tools Read,Glob,Grep "audit this repo without edits"
swarm run --append-system-prompt "Answer in release-note format." "summarize the diff"
swarm run --system-prompt-file ./agent-prompt.md "run this custom agent prompt"
swarm run --skill repo-auditor --skills testing,release-notes "inspect this change"
swarm run --mcp-config ./mcp.servers.json --strict-mcp-config "use only these MCP tools"
swarm run --resume sess_123 "continue with the failing test output"
swarm run --continue "finish the verification"
swarm resume sess_123 "continue with the failing test output"
swarm continue "finish the verification"
swarm watch --gateway-url http://127.0.0.1:38171
swarm watch --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm live --gateway-url http://127.0.0.1:38171
swarm attach --gateway-url http://127.0.0.1:38171
swarm sessions
swarm sessions show latest
swarm sessions watch latest --gateway-url http://127.0.0.1:38171
swarm sessions attach latest --gateway-url http://127.0.0.1:38171
swarm sessions watch sess_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm sessions resume sess_123 "continue with the failing test output"
swarm sessions continue "finish the verification"
swarm reply "focus on the failing tests" --gateway-url http://127.0.0.1:38171
swarm interrupt "stop after the current safe boundary" --gateway-url http://127.0.0.1:38171
swarm reply "focus on the failing tests" --request-id retry-safe-001 --gateway-url http://127.0.0.1:38171
swarm sessions execute sess_plan_123 --gateway-url http://127.0.0.1:38171
swarm sessions fork sess_plan_123 "try the alternative fix path" --gateway-url http://127.0.0.1:38171
swarm sessions stop sess_123 "stop after the current safe boundary" --gateway-url http://127.0.0.1:38171
swarm runs --gateway-url http://127.0.0.1:38171
swarm runs show latest --gateway-url http://127.0.0.1:38171
swarm runs watch latest --gateway-url http://127.0.0.1:38171
swarm runs watch run_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm checkpoints
swarm checkpoints create "before risky refactor"
swarm checkpoints revert last
swarm workers --session sess_123
swarm workers watch worker_123 --gateway-url http://127.0.0.1:38171
swarm workers continue worker_123 "rerun the verification" --gateway-url http://127.0.0.1:38171
swarm handoffs --session sess_123
swarm handoffs watch handoff_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm handoffs take-back handoff_123 --gateway-url http://127.0.0.1:38171
swarm ps --limit 5
swarm run --telemetry telemetry.json --trajectory trajectory.json "inspect this repo"
swarm doctor
swarm doctor ./WORKFLOW.md --workspace ../other-repo
swarm logs
swarm logs latest --tail 80
swarm capabilities
swarm capabilities --all local_tool
swarm capabilities show local_tool.Read
swarm capabilities invoke local_tool.Read path=README.md
swarm capabilities hide local_tool.Read
swarm capabilities unhide local_tool.Read
swarm plugins
swarm plugins show workspace-demo
swarm plugins install ../shared-plugins
swarm plugins disable workspace-demo
swarm plugins validate
swarm skills
swarm skills show repo-auditor
swarm skills activate repo-auditor --session sess_123 --reason "use the repo audit checklist"
swarm mcp
swarm mcp show demo
swarm mcp refresh demo
swarm mcp resources demo
swarm mcp read demo memory://greeting
swarm mcp prompts demo
swarm mcp prompt demo greeting name=Swarm
swarm approvals
swarm approvals pending --gateway-url http://127.0.0.1:38171
swarm approvals show approval_123
swarm approvals approve approval_123
swarm approvals approve approval_123 --gateway-url http://127.0.0.1:38171
```

`swarm work ...` is the short main-path command for the local `coding_loop`.
It accepts the same run flags as `swarm run` and sets `--mode coding_loop`
before execution.

`swarm doctor` prints a local readiness report for the current workspace:
models and API keys, permission mode, core store paths, recent Kernel state,
discovered commands/skills/plugins/MCP servers, latest debug log path, and
Symphony work-source/preflight status. It exits non-zero when the report
contains `FAIL` lines.

`swarm logs` turns `~/.swarm/logs` into a product surface instead of a hidden
implementation detail. With no arguments it lists recent debug logs; with
`latest` or a matching file name it prints the tail of that log.

`swarm watch` gives you one workspace-wide live operator stream through the
Gateway. The default view follows the stable work protocol so queue, activity,
task, permission, worker, and handoff events land in one terminal without TUI
chrome; `--protocol runtime --jsonl` switches to the raw runtime stream for
automation. Use the narrower `sessions`, `runs`, `workers`, or `handoffs`
watch commands when you want one specific scope instead of the whole workspace.
`swarm attach` is the short form for attaching to the latest session stream.

`swarm capabilities` turns the shared capability plane into a first-class CLI
surface. `list` summarizes the loaded catalog, `--all` expands it into the full
provider and capability view, `show` inspects one capability, `refresh`
rebuilds one provider or the whole catalog, `enable` / `disable` and `hide` /
`unhide` persist capability settings, and `invoke` routes through the same
broker used by the TUI and Gateway.

`swarm runs` turns the Gateway's in-memory run table into a first-class CLI
surface. `list` shows active and recent runs for the current Gateway process,
`show` inspects one run including the linked session id and final result when
execution has finished, and `watch` tails the linked session event stream in
real time. The default `watch` view follows the stable work-protocol stream for
operator-friendly queue/activity/task lines, while `--protocol runtime` switches
to the raw runtime event stream and `--jsonl` emits structured watch records for
automation.

`swarm checkpoints` exposes the same local workspace checkpoint source used by
the TUI result card and `/checkpoint` commands. `list` prints recent checkpoint
records for the current workspace, `create <name>` snapshots tracked workspace
state, and `revert [checkpoint_id|last]` restores the latest or named checkpoint.
Pass `--workspace <path>` to operate on another checkout and `--json` for
automation-friendly output. The local Gateway also exposes a bounded
workspace-scoped checkpoint route group for scripts: `GET /v1/checkpoints`,
`POST /v1/checkpoints`, and `POST /v1/checkpoints/:id/revert` delegate to the
same runtime helpers and require Gateway mutation auth for create/revert.
Broader checkpoint orchestration remains deferred beyond that route group.

`swarm sessions` turns persisted Work Kernel sessions into a first-class CLI
surface. With no subcommand it lists recent sessions for the current workspace;
`show` prints the stored snapshot and resume health; `resume` and `continue`
reuse the same headless coding-loop continuation path without making you spell
out `swarm run --resume` every time. `execute` can start a stored plan through
the local Gateway, while `fork` branches a fresh stored plan from an existing
session with an optional new instruction. Headless session resume now shares
the same preflight summary and stored-plan guardrails as the TUI. `watch`
follows one session's Gateway event stream directly so you can keep one
terminal attached to live queue/activity/task updates while using `reply` or
`interrupt` from another; `attach` is the same command for the common "join the
live session" workflow. `stop` and `kill` are aliases for `interrupt`, so
session lifecycle controls use the words operators naturally reach for. The
default view follows the stable work-protocol stream, while `--protocol runtime`
and `--jsonl` expose raw event automation.

`swarm workers` turns persisted worker contracts into a first-class CLI surface.
Local `list` and `show` commands inspect workspace or session-family worker
state, `watch` tails the parent session and attached worker session through the
Gateway so you can follow live delegated progress, and `stop` / `continue`
bridge through the local Gateway to control workers without opening the TUI.

`swarm handoffs` does the same for persisted handoff contracts. `list` and
`show` inspect session-family handoff state, `watch` follows the active handoff
plus the attached worker session, and `take-back` reclaims an active handoff
through the local Gateway while stopping the delegated worker.

`swarm approvals` turns approval history and live approval decisions into a
first-class CLI surface. Local list and `show` commands inspect persisted
approval records for the current workspace or one session family, while
`pending`, `approve`, and `deny` can bridge through the local Gateway to answer
actionable approvals without opening the TUI.

`swarm plugins` turns plugin discovery and plugin enablement into a first-class
CLI surface. `list` and `show` expose the discovered manifest catalog, `install`
and `remove-root` manage explicit plugin roots, `enable` and `disable` persist
plugin trust state, and `validate` reports manifest or contribution diagnostics
without opening the TUI or Gateway.

`swarm skills` turns skill discovery and per-session activation into a first-class
CLI surface. `list` and `show` expose the discovered trusted skill catalog,
while `activate` attaches one named skill to an existing session without opening
the TUI or calling the Gateway directly.

`swarm mcp` turns configured MCP servers into a first-class CLI surface. `list`
and `show` expose the server catalog, `refresh` reconnects a server on demand,
and `resources` / `read` / `prompts` / `prompt` let short-lived CLI processes
inspect or invoke MCP material without relying on an already-running TUI.

`--stream-json` writes JSONL records (`run_start`, `runtime_event`, and
`run_end`) to stdout for SDK wrappers and automation. `run_start` includes the
effective permission mode and sandbox mode so automation can audit whether
approval prompts were enabled, reduced, or bypassed, and whether the run was
allowed to write. Headless runs also handle SIGINT/SIGTERM by asking active work
to stop at the next safe boundary and, when a session exists, printing a TUI
resume hint.

`--sandbox read-only` (or `--read-only`) blocks workspace writes, local command
execution, package installs, branch switches, delegation, and durable context
mutation at tool execution time. It still allows read-only file, git, process
inspection, blackboard read/search/list, and bounded web search/fetch tools.
`--add-dir` adds an existing directory to the read roots for that headless run
without expanding write, shell cwd, or branch-mutation boundaries.

`--resume <session_id>` and `--continue` reuse the same Work Kernel resume
prompt as the TUI: Swarm injects the prior snapshot, compacted memory, replay,
and workspace freshness contract before running the local coding loop again.
Stored planned sessions keep the same guardrails as `/resume`: new instructions
are rejected and should be handled through a fork instead.
`swarm resume ...` and `swarm continue ...` are short aliases for the same
session lifecycle path.
`--max-turns` and `--max-tool-calls` cap local coding-loop budget for headless
runs and are recorded in headless artifacts.

`--allowed-tools` and `--disallowed-tools` apply a per-run tool policy in the
local coding loop, including dynamic tools, and the selected policy is recorded
in stream, report, telemetry, and trajectory artifacts.

`--system-prompt` replaces the run's default behavior prompt, while
`--append-system-prompt` adds instructions after the default or replacement
prompt. `--system-prompt-file` and `--append-system-prompt-file` read those
values from disk. Swarm still injects the coding-loop tool protocol so custom
prompts can change behavior without breaking the local tool bridge; artifacts
record only prompt source and byte counts, not prompt contents.

`--skill NAME` and `--skills A,B` activate trusted Agent Skills for just that
run or resumed session. The activated skill instructions are added before the
first coding-loop turn; chat-mode runs receive the same skill content in the
system prompt. Skill activation is not persisted, and run artifacts record only
the normalized skill names.

`--mcp-config` loads MCP servers for that run from a JSON string or file using
the common `{ "mcpServers": { ... } }` shape. Repeat it to load multiple
configs; later entries override earlier ones. Without `--strict-mcp-config`,
runtime MCP entries override user settings while project and plugin MCP sources
still load normally. With `--strict-mcp-config`, Swarm uses only the supplied
runtime MCP config and skips project, plugin, and persisted MCP sources. Run
artifacts record source type, path, byte count, and server ids, not env values.

`--trajectory` writes an ATIF-v1.7 style trajectory for benchmark harnesses.
`--telemetry` writes Swarm runtime telemetry.

## TUI

The CLI TUI is the only product interface. Headless CLI, Gateway, and Symphony
paths are execution or automation entrypoints.

### Main Controls

| Command | Purpose |
| --- | --- |
| `/help` | Open the grouped slash-command catalog. |
| `/help main` | Show the concise main-path summary. |
| `/help work`, `/help debug`, `/help ext`, `/help symphony` | Jump straight to one command group. |
| `/help all` | Keep the full catalog visible and include every advanced command. |
| `/doctor [workflow_path]` | Diagnose model setup, permissions, Kernel stores, and Symphony preflight. |
| `/mode [auto\|fast\|swarm\|chat]` | Show or change routing mode. |
| `/permissions` | Inspect permission mode, sandbox, rules, read roots, and recent approvals. |
| `/permission-mode [ask\|auto-edit\|full-auto\|yolo]` | Show or change the approval policy. |
| `/sandbox [workspace-write\|read-only]` | Inspect or change the TUI sandbox mode, scope, and write gates. |
| `/why` | Explain recent routing, delegation, review, and verification decisions. |
| `/session [session_id]` | Inspect a persisted Work Kernel session snapshot. |
| `/memory [session_id]` | Show remembered session context and the freshness checks used before resume. |
| `/resume [session_id] [message]` | Resume a previous session with a preflight summary. |
| `/continue [message]` | Continue the latest local coding-loop session with a preflight summary. |
| `/reply <message>` | Send a live reply to the active run. |
| `/add-dir <directory>` | Add a persistent read-only directory to tool permissions. |
| `/remove-dir <directory>` | Remove a persistent additional read directory. |
| `/kernel [workflow_path]` | Show the unified Swarm, Work Kernel, and Symphony status view. |
| `/status` | Alias for the current Kernel status view. |
| `/attempts [session_id]` | Inspect Work Kernel run attempts, failures, workspace, and recovery hints. |
| `/leases [session_id\|lease_id]` | Inspect Work Kernel workspace leases and write boundaries. |
| `/work-items [workflow_path]` | Inspect local Symphony active and terminal work items. |
| `/symphony [workflow_path]` | Inspect local Symphony scheduler/session status. |
| `/symphony-run-once [workflow_path] [--max-turns N]` | Dispatch and execute one Symphony tick from the TUI. |

By default `/help` opens the grouped slash-command catalog in a detail view,
while `/help main` keeps the shorter summary. Slash completion still biases toward the main path
until you type more of a command. Capability and extension surfaces also start
with summaries; use `/capabilities all`, `/commands all`, `/skills all`,
`/plugins all`, or `/mcp all` for the full advanced catalog.

For stored planned sessions, `/resume <session_id> <message>` does not silently
discard the new message anymore. Swarm now asks you to use `/fork <session_id>
<message>` when you want to branch a new instruction onto a stored plan.

Live replies and explicit interrupts now fail closed when no active run can
receive them. `/reply`, `/interrupt`, `swarm reply`, `swarm interrupt`,
`swarm sessions reply`, `swarm sessions interrupt`, Gateway
`POST /v1/live/messages`, `POST /v1/live/interrupt`,
`POST /v1/sessions/:id/messages`, `POST /v1/sessions/:id/interrupt`, and MCP
`swarm.send_message` / `swarm.interrupt` no longer claim work was queued when
nothing compatible is running. `swarm sessions execute` and
`swarm sessions fork` now bridge the same stored-plan control routes that the
Gateway already exposed. Explicit interrupts now stop active local
`coding_loop` runs immediately at the next safe loop boundary, and active
`full_swarm` runs become safe-boundary stop requests that take back active
handoffs before Swarm returns a stopped result.

Approval inspection follows the same rule now: Gateway approval routes and MCP
approval tools distinguish persisted approval history from live actionable
requests. `pending_requests` and `actionable_approval_ids` are only for the
current Gateway process; `approvals` is the persisted Work Kernel history.
MCP `swarm.session_status` and `swarm://sessions/<id>` now reuse the same
session snapshot as Gateway, including `work_snapshot`, `task_contracts`, and
`work_contracts`. `swarm://sessions/<id>/approvals` exposes the persisted
approval history as a read-only resource.
Gateway `GET /v1/sessions` and MCP `swarm.session_status` without a
`session_id` now also share one workspace overview contract: recent sessions,
approval summary, workspace work contracts, MCP server catalog, and active live
target state come back in the same shape for local automation and MCP clients.

Common advanced controls include `/self-review`, `/improve-self`, `/evals`,
`/read`, `/grep`, `/glob`, `/shell`, `/web`, `/diff`, `/output`, `/workers`,
`/handoffs`, `/approvals`, `/audit`, `/usage`, `/symphony-tick`,
`/symphony-daemon`, `/symphony-start`, `/symphony-stop`,
`/symphony-cleanup`, `/capability-enable`, `/capability-disable`,
`/commands`, `/plugin-install`, `/plugin-enable`, `/plugin-disable`, `/skill`,
`/mcp-refresh`, `/mcp-resources`, `/mcp-read`, `/mcp-prompts`, and
`/mcp-prompt`.

Markdown files under `~/.swarm/commands`, `.swarm/commands`, or configured
`settings.extensions.commands.roots` become custom prompt slash commands. A file
named `review.md` creates `/review`; frontmatter can set `name`, `description`,
and `argument-hint`. Trusted plugin slash commands appear in the same `/commands`
catalog and slash completion surface. The prompt body is sent through the normal
Swarm run loop and `$ARGUMENTS` is replaced with the slash command arguments.
Project commands follow the same trusted-workspace posture as other project
extensions.

The TUI header shows the active permission mode and sandbox mode. `/sandbox`
now reports the current TUI-only sandbox scope, read roots, and the interaction
between sandbox and permissions. `/sandbox read-only` routes runs through the
local coding loop sandbox so write-like tool actions are denied at execution
time; `/sandbox workspace-write` restores normal workspace writes subject to the
permission policy.

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

The chat pane is conversation-first in every state: while work runs, while an
approval or plan waits, and after a result, the transcript stays on screen. A
one-line header names the model, workspace, mode, permission and sandbox; while
busy, one status line shows the current activity, elapsed time and running
workers; the latest result is a compact line at the end of the transcript. A
"needs you" strip appears above the prompt only when a ticket waits for a
person, each line naming the command that answers it.
The operator surface lives in the other panes.
Use `/view` for focused Kernel panes such as Trace, Overview, Output, Sessions,
Attempts, Activity, and Blackboard. Overview keeps the prompt surface quiet; the
Activity pane summarizes workers, approvals, and background work without making
agent internals the default view. The other panes expose the fuller local state
when needed. The header and Kernel overview show the latest actual route selected by auto mode,
such as `coding_loop` or `full_swarm`, with confidence and the router reason.

The TUI creates a local Work Kernel session for the current chat state. Slash
tool approvals and tool results are recorded against that session, so `/session`,
`/attempts`, `/approvals`, `/audit`, and `/usage` can inspect TUI-local work
instead of showing detached tool events.

While work is running, the TUI keeps a stable current-action row plus a short
activity timeline. Thinking turns, read-only tool batches, individual tools,
approval waits, and turn completion stay visible without opening the full trace.
Prompt-cache status stays in the result card and `/debug cache` detail surface
instead of crowding the default conversation.

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

`agent.delegate` is still coordinated by the main Swarm. Multiple Agent calls in
one model turn only run concurrently when they explicitly request
`preferred_mode: "parallel"` and either target a read-only agent spec such as
`researcher`, `reviewer`, `critic`, or `architect`, or target a
`scoped_write` agent spec with a concrete `file_scope` that does not overlap
with sibling delegates in the same batch. `workspace_write` agents, handoffs,
overlapping write scopes, glob-style scopes, and ordinary delegate calls remain
serialized to avoid workspace conflicts. Concurrent batches are capped by
`runtime.maxParallelTasks`. When that cap is saturated, additional delegated
workers are persisted as `pending`, surfaced in the work-contract snapshot, and
started automatically when a worker slot opens instead of failing immediately.

For `scoped_write` agents, `file_scope` is enforced before write tools execute:
file writes, edits, patches, moves, deletes, JSON edits, and notebook edits must
target paths inside the delegated scope. Package installs and branch switches
stay outside the scoped-write sandbox.

## Safety And Permissions

Tool approval is driven by `~/.swarm/settings.json` permission rules. High-risk
actions such as shell, package install, delegate, write/edit, web fetch, and
branch mutation are held until the user confirms in the TUI unless the active
permission mode allows them. Destructive `r4` shell commands still require
confirmation unless an explicit permission rule allows that exact action.

The approval view shows why the tool is needed, predicted impact, rollback
guidance, target details, and diff-style previews for proposed write, edit, and
JSON changes when Swarm can derive them before execution. Previews for sensitive
targets such as `.env`, secrets, tokens, credentials, and keys are redacted in
approval records. Use `y` or `a` to allow once, `s` to allow the same action and
target for the current TUI session, or `n` or `d` to deny.

Permission modes:

| Mode | Behavior |
| --- | --- |
| `ask` | Ask before risky actions. |
| `auto-edit` | Allow lower-risk edits but keep risky operations gated. |
| `full-auto` | Reduce prompts while preserving deny rules. |
| `yolo` | Temporary opt-in mode for skipping approval prompts while preserving workspace and deny-list boundaries. |

Deny rules override everything. Explicit allow rules win over mode defaults. Custom
ask rules still require approval, even in `full-auto` or `yolo`; the baseline
ask catalog does not cancel those bypass modes by itself.

Headless runs can override the mode for a single process with
`swarm run --permission-mode ask|auto-edit|full-auto|yolo ...`.
By default, headless mode fails closed when an approval is required. Use
`swarm run --approval-mode wait ...` to persist the pending approval locally and
wait for another terminal to answer it with `swarm approvals approve <id>` or
`swarm approvals deny <id>`. Use `--approval-timeout-ms <ms>` to change the
default 10 minute wait.
They can also force a read-only tool sandbox with
`swarm run --sandbox read-only ...` or `swarm run --read-only ...`, and add
temporary read-only roots with `swarm run --add-dir <dir> ...`.
In the TUI, `/permissions` reports the effective mode, sandbox, rule counts,
read roots, and recent approvals. `/add-dir <dir>` and `/remove-dir <dir>`
update persistent `permissions.additionalDirectories` for future runs.

## Local Gateway

`swarm serve` starts a local HTTP/event-stream API for scripts, editor
integrations, and debugging. It defaults to `http://127.0.0.1:38171`.

```bash
swarm serve
swarm serve --port 0
```

Gateway binds to loopback by default. State-changing requests require either
the local CLI's `X-Swarm-Local-Control` header from a loopback client or a
`SWARM_GATEWAY_TOKEN` bearer token. Remote binding is refused unless both
`SWARM_GATEWAY_ALLOW_REMOTE=1` and `SWARM_GATEWAY_TOKEN` are set. CORS is
limited to loopback origins unless `SWARM_GATEWAY_ALLOWED_ORIGINS` lists
comma-separated origins.

The `/` route returns a JSON API index. It is not a product interface;
user-facing workflows live in the CLI/TUI.

`/health` returns the current public route list from the running Gateway.
Important endpoint groups:

| Group | Routes |
| --- | --- |
| Runs and sessions | `POST /v1/sessions`, `GET /v1/runs`, `GET /v1/events`, `GET /v1/work-events`, `GET /v1/sessions/:id/events`, `GET /v1/sessions/:id/work-events` |
| Live control | `GET /v1/live`, `POST /v1/live/messages`, `POST /v1/live/interrupt`, `POST /v1/sessions/:id/messages`, `POST /v1/sessions/:id/interrupt`, `POST /v1/sessions/:id/execute`, `POST /v1/sessions/:id/fork` |
| Kernel inspection | `GET /v1/sessions/:id/graph`, `/tasks/:task_id`, `/trace`, `/blackboard`, `/approvals`, `/audit`, `/usage` |
| Collaboration | `GET /v1/workers`, `GET /v1/workers/:id`, `POST /v1/workers/:id/stop`, `POST /v1/workers/:id/continue`, `GET /v1/handoffs`, `GET /v1/handoffs/:id`, `POST /v1/handoffs/:id/take-back` |
| Capabilities | `GET /v1/capabilities`, `POST /v1/capabilities/:id/invoke`, enable/disable/show/hide, refresh |
| Extensions | `GET /v1/skills`, `POST /v1/skills/:name/activate`, `GET /v1/plugins`, plugin install/update/remove/enable/disable |
| MCP | `GET /v1/mcp/servers`, server refresh, resource list/read, prompt list/get |
| Symphony | `GET /v1/symphony/status`, preview, tick, run-once, cleanup, daemon start/stop |

`/v1/events` keeps the runtime event stream for existing clients and includes a
`work` field on each record. `/v1/work-events` streams the stable `swarm.work.v1`
records directly for automation that wants the shared run/session/task/permission
protocol without TUI-specific event shapes. That stream now carries first-class
`queue` records for worker-slot admission and `activity` records for structured
worker progress, instead of forcing clients to reverse-engineer runtime strings.
`GET /v1/live` returns a direct live status contract with `status`,
`active_target`, `controls`, and the active session snapshot when a Gateway run
is currently controllable; the `swarm live` CLI command prints the same surface.
Live reply and interrupt routes return the applied `control` decision when the
active loop can classify the message, and stored planned executions are exposed
as `full_swarm` live targets while they run. `POST /v1/live/messages`,
`POST /v1/live/interrupt`, `POST /v1/sessions/:id/messages`, and
`POST /v1/sessions/:id/interrupt` also accept an optional `request_id`
idempotency key; retries with the same key return the original result with
`duplicate: true` instead of injecting or interrupting twice.
`GET /v1/sessions/:id` also returns
`work_snapshot.work_contracts` and a top-level `work_contracts` summary so
Gateway consumers can restore active/resumable worker contracts and their
delegated write scope without replaying the full event stream. `GET /v1/workers`
and `GET /v1/handoffs` now also return `worker_contracts` / `handoff_contracts`,
and `parent_session_id=<session>` filters those collaboration views down to one
session's delegated work. Session snapshots also expose `task_contracts`, while
`/v1/sessions/:id/graph` and `/v1/sessions/:id/tasks/:task_id` carry task
policy and file-scope metadata directly.

Approval routes now expose live actionable queue state as well as persisted
history. `GET /v1/approvals?session_id=<session>` and
`GET /v1/sessions/:id/approvals` return `pending_requests`,
`actionable_approval_ids`, and a summary alongside persisted `approvals`.
`GET /v1/approvals/:id` marks whether that approval is still actionable in the
current Gateway process, and MCP exposes the same view through
`swarm.approvals`. `swarm.approval_decision` now fails closed when the approval
is no longer actionable instead of returning an ambiguous `found=false`.

## Symphony

Symphony is the background work intake and scheduler. It reads local work items,
creates per-item workspaces, and runs the same Work Kernel runner used by the
TUI.

```bash
swarm symphony preview --workflow WORKFLOW.md
swarm symphony tick --workflow WORKFLOW.md
swarm symphony run-once --workflow WORKFLOW.md --max-turns 12
swarm symphony status --workflow WORKFLOW.md
swarm symphony daemon --workflow WORKFLOW.md --execute --max-ticks 3
swarm symphony cleanup --workflow WORKFLOW.md --execute
```

Symphony writes sessions, attempts, workspace leases, blackboard records, audit,
usage, and final outcomes into the same local Work Kernel stores. It does not
own a separate planner, blackboard, review system, or product UI.

When `WORKFLOW.md` is present, the runtime also owns a lightweight internal
system loop that can wake Symphony automatically on startup and on relevant
runtime events such as blackboard work-source updates, task/artifact envelopes,
and completed sessions. Configure it in workflow front matter:

```yaml
system_loop:
  enabled: true
  execute: false
  startup_tick: true
  tick_on_events: true
  debounce_ms: 250
```

`execute: false` only dispatches Work Kernel sessions. Set `execute: true` when
the workflow should run local work items through the same coding-loop runner
without a separate `symphony run-once` or daemon command.

## Tickets

`swarm superagent` is a proactive team agent for one repository, adapted from
[dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype). A
person who is allowed to ask for work mentions the agent on GitHub, messages its
Feishu bot, or types `/ticket <request>` in the TUI. A deterministic gate checks
who sent it before any model sees it; a model routes the request to a new
ticket, an existing one, a stop or nothing. Each ticket gets a worker process
running Swarm's coding loop, or another agent harness such as Claude Code, in
its own directory (usually a git worktree made by a prepare command), and the
worker answers in the conversation where it was asked. Later messages on that conversation go straight to the ticket's worker.

```bash
swarm superagent config init      # write ~/.swarm/superagent/settings.json
swarm superagent run              # run the host: Sources, routing, workers, replies
swarm superagent request "fix the typo in README"
swarm superagent tickets          # what waits for a person first
swarm superagent say <id> "use build.sh"
swarm superagent stop <id>
swarm superagent retry <id>
```

In the TUI, `/ticket <request>` files work, `/ticket <id>` shows a ticket,
`/ticket say|stop|retry <id>` acts on one, and `/tickets` opens the tickets pane
(arrows select, Enter opens, `s` stops, `r` retries, Esc returns). When no host
runs, the TUI starts one that stops when it quits.

Proactive work, such as an unaddressed comment that matches a team rule, starts
in `observe` mode: the assessment is recorded as "would accept" and nothing runs
until `eval.mode` is `auto`. GitHub and Feishu stay off until they are set up
with an agent account and a bot. Workers run as your OS user in `full-auto`
permission mode; the `gh`/`lark-cli` wrappers and blocked commands are defaults,
not a security boundary, and messages on a ticket's threads reach its worker as
context, so use a dedicated OS account for repositories where strangers comment.
Feishu images are not read during assessments yet. See `docs/SUPERAGENT.md`.

### Harness workers

A ticket's worker can run on another agent harness installed on the machine
instead of Swarm's own coding loop: Claude Code (`claude`), Codex (`codex`), Kimi
Code (`kimi`) or OpenCode (`opencode`), or Claude Code on GLM or DeepSeek
(`claude-glm`, `claude-deepseek`, below). `executor.harness` in the superagent
settings names the harness new tickets run on (`null`, the default, keeps
Swarm's loop); `swarm superagent request --harness claude "..."` or `/ticket
--harness codex <request>` chooses one for a single request. The choice is stored with the ticket's execution, so its follow-ups run
on the same harness, and `swarm superagent tickets`/`ticket` and the TUI show it
as `via claude`.

Each turn is one headless run in the ticket's directory, with Swarm's ticket
tools (`swarm superagent mcp`, plus `--remote` for a worker placed on a paired
node) as the MCP server `ticket` and Swarm's worker instructions added to the
harness's own:

| Harness | Turn | Ticket tools | Instructions | Resume |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json` | `--mcp-config`, and only those (`--strict-mcp-config`) | `--append-system-prompt` | `--resume <id>` |
| Codex | `codex exec --json` | `-c mcp_servers.ticket.*` | `developer_instructions` | `codex exec resume <id>` |
| Kimi Code | `kimi --prompt <prompt> --output-format stream-json` | added to the directory's `.kimi-code/mcp.json` for the turn and put back after it, with `KIMI_CODE_TRUST_WORKSPACE=1` | an agent file (`--agent-file`) with Kimi's own prompt first | `--session <id>` |
| OpenCode | `opencode run --format json --agent swarm` | `OPENCODE_CONFIG_CONTENT`, which OpenCode merges above your config for that process | an instructions file named in that config | `--session <id>` |

Kimi Code has no flag for an MCP server or extra instructions, so a ticket's
turn writes the project-level `.kimi-code/mcp.json` in the ticket's directory
(keeping whatever else is in it) and restores the file when the turn ends; the
trust variable is what lets a headless run read it, and it also enables MCP
servers the repository itself declares there or in `.mcp.json`. A Kimi session
keeps the agent file's instructions it started with. Files Swarm writes for a
turn, such as Kimi's agent file, OpenCode's instructions and Claude Code's
settings file, live in a private temporary directory that is removed when the
turn ends. Later turns resume the harness's session with the messages that
waited for the ticket; the session ids are kept in
`~/.swarm/state/harness-sessions/`. Reports, the reminder after a turn without a
report, retries of failed turns, the budget per turn (60 model messages and 200
tool calls, counted from the harness's events) and stopping work as they do for
Swarm's loop, except that a message that arrives during a harness turn waits for
the next turn. Each turn's tokens go to Swarm's usage records with the harness
and its model: Codex's model from its session file, Kimi Code's tokens and model
from its session's wire files (its events carry neither), and OpenCode's model
from `opencode export`. Claude Code's cost is its own list-price estimate, and
OpenCode's is the sum of the cost it reports for each model call. Claude Code
prices every model at Claude's rates, so on `claude-glm` and `claude-deepseek`
its cost is wrong (a live DeepSeek turn it put at $0.127 cost about $0.003 at
DeepSeek's prices); the token counts in the usage records are right.

Before its first turn a worker checks that the harness is installed and signed
in (`claude auth status`, `codex login status`, `kimi provider list` with
Kimi's token file, `opencode auth list`); if not, the ticket fails with what to
do on that machine, and Swarm never signs in for you. A harness runs as
it is set up for your OS user, with its own login, configuration, instructions
and hooks. Two things Swarm adds to every turn: Claude Code's `attribution`
setting with every part empty (`--settings`, which overrides your own settings),
so its commits and pull requests carry no Co-Authored-By trailer or "Generated
with" line; and instructions to stage only the files the ticket changed, by
path, so files a hook leaves in the ticket's directory stay out of its commits.
Codex adds its own trailer only when your ChatGPT workspace turns attribution
on, which Swarm cannot switch off; the instructions ask it not to. Kimi Code
2.1.1 and OpenCode 1.18.21 add no attribution of their own in these modes.
Profiles under `executor.harnesses` change the built-in ones (command, model,
arguments, environment) or add others of any kind; credentials never go in the
settings: `keys` names the environment variable each one is read from. A
profile's own variables and keys also go in Claude Code's `--settings`, as a
file in the turn's temporary directory, because the `env` of your
`~/.claude/settings.json` (such as an `ANTHROPIC_BASE_URL` for a relay) would
otherwise override them.

```json
"executor": {
  "harness": "claude",
  "harnesses": {
    "claude": { "model": "sonnet", "env": { "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1" } },
    "codex": { "command": "/Users/me/.local/bin/codex", "args": ["--profile", "work"] },
    "opencode": { "model": "deepseek/deepseek-flash" },
    "relay": { "kind": "claude", "env": { "ANTHROPIC_BASE_URL": "https://relay.example/anthropic" },
      "keys": { "ANTHROPIC_AUTH_TOKEN": "RELAY_API_KEY" } }
  }
}
```

An Anthropic-compatible relay that rejects Claude Code's experimental beta
headers (an HTTP 400 naming an `anthropic-beta` value) needs
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` in the profile's `env`, as above.
Variables that an enclosing Claude Code session gives its own tools
(`CLAUDECODE`, the desktop app's host-managed provider) are dropped, so a host
started from inside Claude Code still finds the account the harness signs in
with.

#### GLM and DeepSeek behind Claude Code

Two built-in profiles run Claude Code on other models through their providers'
Anthropic-compatible endpoints, with the variables those providers' Claude Code
guides set (Zhipu's [GLM Coding Plan guide](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)
and [DeepSeek's](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code),
as of November 2026). Their keys come only from the environment:

| Profile | Endpoint (`ANTHROPIC_BASE_URL`) | Model | Key |
| --- | --- | --- | --- |
| `claude-glm` | `https://open.bigmodel.cn/api/anthropic` | `glm-5.3[1m]`; Haiku-class `glm-5.3-flash[1m]` | `ZHIPU_API_KEY` |
| `claude-deepseek` | `https://api.deepseek.com/anthropic` | `deepseek-flash[1m]` for every class | `DEEPSEEK_API_KEY` |

Both also set the providers' other variables (the auto-compact window, and for
GLM `API_TIMEOUT_MS=3000000` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).
Settings add to a built-in model profile instead of replacing it, so Z.ai's
international GLM endpoint is `"claude-glm": { "env": { "ANTHROPIC_BASE_URL":
"https://api.z.ai/api/anthropic" } }`, and another key variable is `"keys": {
"ANTHROPIC_AUTH_TOKEN": "MY_GLM_KEY" }`. DeepSeek maps any `claude-opus*` model
name to `deepseek-v4-pro`, billed at its price. OpenCode reaches both natively,
without Claude Code: a profile `{ "kind": "opencode", "model":
"deepseek/deepseek-flash" }` (or `zhipuai-coding-plan/glm-5.3`, or Z.ai's
`zai-coding-plan/glm-5.3`) uses the key from `opencode auth login` or from
`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY`.

#### Checking the harnesses here

`swarm harness list` (also `swarm superagent harness list`) prints each profile
with its kind, command, model, whether it is installed, and the variables its
keys come from and whether they are set, by name only. `swarm harness check
[<id>]` also runs each harness's sign-in status command and says what to do
about one that is not signed in; with an id it exits non-zero when that profile
cannot run here. Both take `--json`.

The ticket's permission mode maps to the harness's own flags:

| `executor.permissionMode` | Claude Code | Codex | Kimi Code | OpenCode |
| --- | --- | --- | --- | --- |
| `full-auto` | `--permission-mode auto` (its classifier blocks risky actions); prompts are denied | `-s danger-full-access` with `approval_policy="never"`: no sandbox (see below) | its Never Ask mode, which `--prompt` always uses | an agent that allows everything but the blocked commands, with `--auto` |
| `yolo` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | as `full-auto` | as `full-auto` |

Codex runs without its sandbox in both modes. Its `workspace-write` sandbox keeps
a workspace's own git metadata read-only, so a worker there cannot commit unless
someone approves each commit; in live trials the ticket ended blocked with
approvals off, and also with `--approve-for-me` when the provider did not serve
Codex's reviewer model or the model did not ask it. Swarm's own worker is not
sandboxed either: it runs as your OS user.

Swarm cannot enforce its own rules inside another harness. Its permission
rules in `~/.swarm/settings.json`, its risk levels and the approval it asks for
destructive commands do not apply there; the harness decides with its own mode,
classifier or sandbox, and Swarm does not see or audit each tool call. Blocked
commands reach the harness only as Swarm's `PATH` shims, and as deny rules in
Claude Code and OpenCode; Codex and Kimi Code have no flag to deny a command,
and any harness can run a program by its full path. Claude Code gets only the
ticket tools (`--strict-mcp-config`); Codex, Kimi Code and OpenCode also load
the MCP servers, plugins and instructions of their own configuration. The
budget stops a harness after the fact, from the events it prints, and the usage
is what the harness reports.

### Harness subagents

Subagents that the main Swarm delegates to (`agent.delegate`, the `Agent` tool)
run in-process on Swarm's coding loop, or on a harness: an agent spec's
`harness` field (a plugin's agent spec can set it too) or the delegate call's
`harness` input names the profile, and the call's wins. The subagent then runs
as one headless turn of that harness in the delegating session's workspace,
with the spec's role, output contract and file scope as its instructions, the
task packet as its prompt, no ticket tools, and the spec's tool budget as the
turn's limits (`max_tool_calls` tool calls, and `max_turns + max_tool_calls`
model messages). Its result returns to the parent as Swarm's workers return
theirs: the harness's final message as the summary, followed by a line saying
which harness and model ran and what it could not be held to, and the changed
files from git status and HEAD before and after the turn. A delegate call that
names a harness skips Swarm's check that small single-file tasks stay in the
main loop.

The spec's write policy is kept as far as the harness's own flags allow:

- A `read_only` spec runs in the harness's read-only mode: Claude Code in its
  `dontAsk` mode with only Read, Grep, Glob and git's status, diff, log and
  show; Codex in its read-only sandbox (MCP servers from your Codex
  configuration run outside it); Kimi Code with an agent that has only reading,
  search and web tools; OpenCode with an agent that denies everything but
  reading, searching, the web and git's read-only commands. A profile whose own
  `args` set the harness's permissions, sandbox or tools (such as
  `--dangerously-skip-permissions` or `--auto`) cannot be kept read-only, and the
  subagent does not start: the parent gets a failed result that says why.
- A `scoped_write` or `workspace_write` spec runs in the harness's `full-auto`
  mode (`yolo` when Swarm runs in yolo). The harness is not confined to the
  file scope or the workspace; files it changed outside the file scope are
  named in the summary. In the `ask` and `auto-edit` permission modes Swarm asks
  for approval once before such a subagent starts, as it cannot ask for each
  edit or command inside the harness. It is told not to commit, push or open
  pull requests.

Parallel delegation can mix harnesses: a writer on OpenCode and a reviewer on
Claude Code read-only, for example, each in the background with its own
result. Their tokens go to the runtime's usage records with the harness and
model, under the worker.

## Mesh

Swarm devices link into a swarm: a laptop, an always-on server and a GPU box join with a short pairing code and then
reach each other wherever they are. One device shows a code, every other device joins with it, and each one that
joins is paired with every member, not just the one that showed the code.

```bash
swarm mesh invite                          # on any member: prints a code such as K7QM-4ZX2 and waits
swarm mesh join K7QM-4ZX2                  # on each device to add (or /mesh join K7QM-4ZX2 in the TUI)
swarm node run                             # on devices that others should reach: the ticket host and mesh server
swarm node install                         # the same as a service: up now, at login and after a crash
swarm mesh status                          # this node and its peers: how each is reached, abilities, load
swarm mesh remove gpu                      # take a device out of the swarm: every member forgets it
```

A code works for 15 minutes for any number of devices, and three wrong tries cancel it. In the TUI, `/mesh invite`
opens one while the TUI runs and `/mesh` lists the swarm.

Each pair of devices shares a key, agreed during pairing with a password-authenticated key exchange (CPace): the code
proves both devices saw it, without the code or the key ever crossing the network. Every connection between two
devices is TLS keyed with their shared key, so only the two of them can read it or finish its handshake, and the key
tells a node which peer is calling. Devices connect directly when one reaches the other (a LAN, a tailnet, a
forwarded port set with `swarm mesh advertise`) and through the relay otherwise; the first link to finish its
handshake wins. The relay (`wss://swarm-relay.w33d.xyz` unless `swarm mesh relay <url>` names another, or
`swarm mesh relay off` turns it off) only joins streams: it sees which device names connect, when and how much,
never what they say. A device listens there under a name only its key can claim, and every dial to a device is signed
with the dialing device's key, so the relay limits each device as well as each address; a device that is pairing
dials the code's mailbox unsigned, under a tighter limit. `swarm mesh relay serve` runs one, and its `/v1/health`
answers counts; a code made on a device using another relay names it (`K7QM-4ZX2@relay.example`), so joining needs no
setting. Without a relay, `swarm mesh invite --direct` prints a long one-time code with this node's addresses.

A device joining through a member is introduced to the others by vouchers: the member seals the new pair's key for
each other member with the key it shares with that member, and the new device's first connection to a member shows
it. A device removed with `swarm mesh remove` is forgotten by every member that hears of it, and its old
introductions are refused.

Paired devices' tickets appear beside this node's in the TUI (`/tickets`, the needs-you strip) and in
`swarm superagent tickets --all-devices`, addressed as `<device>:<id>`. Answering, stopping and retrying one goes to
the device that owns it, and `/ticket @<device> <request>` (or `swarm superagent request --device <name>`) files
work there. A paired device acts as that device's own operator, so pair only devices you control.

A device can also lend its paired peers tools, which their Swarm sessions call as MCP tools. Nothing is lent until
you name folders: `swarm mesh lend shell ~/src/app` lends running commands that start in that folder (a shell can
still reach anything this user can), and `swarm mesh lend files ~/data` lends listing, reading and writing files
inside it, refusing paths that lead out, symlinks included. `swarm mesh lend` shows what is lent and
`swarm mesh lend --stop shell` takes it back. On the other devices `swarm mesh tools` lists what each peer lends, and
every Swarm session there sees it as `mcp__<peer>__shell`, `mcp__<peer>__read_file` and so on, served by the peer's
`swarm node run` over Streamable HTTP on the link to that peer. Borrowed tools count as remote, so in `ask` mode each
call waits for approval; a peer that does not answer is skipped.

A ticket can also stay on this node while its worker runs on a paired one. `swarm superagent request --on <node>`
(or `/ticket --on <node> <request>`) files it that way, `swarm superagent place <id> <node>|here` moves its next
worker, and when the router says the work needs `gpu` or `macos`, the worker goes to a paired node that has that
ability and a free slot. The node that accepted the ticket remains its record and the only writer of its store. The
other node prepares its own ticket directory with its own prepare command and credentials (a node that runs GitHub
tickets needs the agent account's CLI signed in there) and holds a lease it renews; if the lease lapses, the owner
treats the worker as lost and places the work again. `swarm superagent ticket` shows where a worker runs. Placement
takes effect on a node run as `swarm node run`.

A node with free worker slots can also pull work instead of waiting to be handed it. Pulling is off until
`swarm mesh pull on` (add `--repo owner/name`, repeatable, to take only those repositories' work); the node then asks
its paired nodes, every 15 seconds and less often while nothing is open, for work that waits there for a worker:
queued behind `executor.maxWorkers`, or needing an ability the owner lacks while the paired nodes that have it and
pull are busy (such work waits for them instead of running on the owner). It claims what its abilities and
repositories fit, oldest first. The owner decides: the first claim that is still valid gets the work through the
same offer and lease as placement, later ones are refused, and the owner never starts a claimed Assignment itself.
Work placed with `--on` or `place`, held under a lease, or waiting for a person is never open. Owners hand their
waiting work to paired nodes that pull by default, because pairing already lets a peer run this node's work when it
is placed there and a puller only takes work that would otherwise wait; `swarm mesh offer off` keeps it.
`swarm mesh status` shows whether each node pulls and the work pulled either way, and ticket rows say
"pulled by <node>".

### Keeping Nodes Up And Current

`swarm node install` runs this device's node as a service the system keeps up: a launchd LaunchAgent
(`~/Library/LaunchAgents/com.agent-swarm.node.plist`) on macOS, a systemd user unit
(`~/.config/systemd/user/swarm-node.service`) on Linux. It starts at once and at each login, restarts after a crash,
and runs the Node binary and `dist/index.js` of the install that ran it, as `node run` (`--no-host` passes through).
Its output goes to `~/.swarm/logs/node.log`, which moves to `node.log.1` once it passes 10 MB. `swarm node logs -f`
follows it, `swarm node status` says whether the service is installed and loaded, its pid and how it last ended, and
`swarm node uninstall` removes it, keeping the log and the env file. Installing again restarts the node. Install
refuses while another superagent host runs on the device (a `swarm node run` in a terminal, or a TUI that started
one), because only one host holds the device's lock: stop that one first.

A service does not see your shell's environment, only `PATH` and Swarm's own `SWARM_HOME` and `SWARM_MESH_HOME`.
Keys the node and its workers need from the environment (provider keys, `GH_TOKEN`) go in `~/.swarm/node.env`, one
`KEY=value` per line: install creates it with instructions and mode 600, and the node loads it at each start with
Node's `--env-file-if-exists`. Nothing secret is written into the plist or unit, and keys saved with
`swarm auth set-key` already live in Swarm's settings. On a headless Linux box, `loginctl enable-linger` keeps the
user's services running without a login session and starts them at boot; install says when lingering is off. In a
container, run `swarm node run` under the container's restart policy instead.

Each node's card names its Swarm version, its commit when it runs from a git checkout, and the mesh protocol it
speaks: 1 now, bumped whenever the link or route formats change (cards from before the field speak 1).
`swarm mesh status` and `/mesh` in the TUI mark a peer that speaks another protocol, which may not work with this
node, or runs another Swarm version or commit, and say to update one of them with `swarm update`.

## Usage, Prices And Budgets

Each device records every model call it makes and every harness turn its ticket workers run in
`~/.swarm/state/swarm.db`: Swarm's own sessions, ticket workers, and the ticket host's routing and assessment calls,
each with its provider, model, harness and tokens. `swarm usage` reads them as a ledger that counts each call once:

```bash
swarm usage                                   # the last 7 days on this device, by model
swarm usage --since 30d --by provider         # or by harness, device, ticket, day or source
swarm usage --since 2026-11-01 --all-devices  # adds every paired device that answers
swarm usage --since 24h --json
```

`input` counts every prompt token, cache hits and cache writes included, and `cached` the cache hits. In the TUI,
`/usage [session_id]` (also `/debug usage`) shows a session's calls and this device's day, and
`GET /v1/sessions/:id/usage` adds the same ledger as `ledger` beside its raw counters, whose token rows overlap.
`--all-devices` reads each paired device's calls through its `swarm node run`, prices them with this device's
prices, and names a device that does not answer or runs a Swarm without the route.

Costs come from a price table per million tokens. Swarm ships prices only for models whose providers' pricing pages
confirmed them on 2026-11-07, each page cited in `src/usage/prices.ts`: DeepSeek Flash (also its retired
`deepseek-v4-flash` names) and V4 Pro with their peak hours, Kimi K3.1 Pro, K3, K2.7 Code and K2.6 on `moonshot`,
OpenAI GPT-5.5, GPT-5.4 and GPT-5.4 mini, Claude Sonnet 4.5 and Haiku 4.5, and Gemini 2.5 Pro and Flash. Every other
model shows its tokens and `unpriced` until `usage.prices` in `~/.swarm/settings.json` gives it a price, which also
replaces a shipped one:

```json
{
  "usage": {
    "prices": {
      "deepseek/deepseek-v4-flash": { "input": 0.15, "cachedInput": 0.003, "output": 0.6, "currency": "USD",
        "peak": { "hoursUtc": [[1, 4], [6, 10]], "factor": 2 } },
      "openai/gpt-5.5": { "input": 5, "cachedInput": 0.5, "output": 30, "long": { "above": 272000, "input": 10, "cachedInput": 1, "output": 45 } },
      "ollama/*": { "input": 0, "output": 0 }
    },
    "budgets": {
      "providers": { "deepseek": { "daily": 2, "monthly": 30 }, "kimi-coding": { "dailyTokens": 5000000 } },
      "harnesses": { "claude": { "monthly": 100 } }
    }
  }
}
```

A price is keyed `<provider>/<model>`, or `<provider>/*` for all of a provider's models. `cachedInput` (cache hits)
and `cacheWrite` (tokens written to the cache) default to `input`, `currency` to USD; `long` prices a prompt over
`above` tokens, and `peak` multiplies every rate in its UTC hours, Monday to Friday. A harness turn that reports its
own cost, as Claude Code does, keeps it; other turns are priced by `harness:<id>/<model>` or `harness:<id>/*`.

Budgets cap a provider's calls, or a harness's turns, per day (from local midnight) and per month (from the 1st):
`daily` and `monthly` in money (`currency`, USD by default), counting priced calls, or `dailyTokens` and
`monthlyTokens`, counting input and output tokens. Each device counts its own calls. Once a cap is reached, new model
calls on that provider fail, and a harness's next turn does not start, with a message that names the cap, what went,
and the setting that raises it; a ticket whose worker hits it gets a blocked report saying so, to retry once the cap
is raised, and the TUI shows a notice above the prompt. Caps are read again before every call, so raising one
applies at once. They are checked before a call, not during it: calls already running finish, and parallel calls can
pass a cap by what they use. `swarm usage` and `/usage` show each cap's state and how many calls a money cap could
not count for lack of a price.

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
| `SWARM_LSP_TYPESCRIPT_COMMAND` | Override the TypeScript LSP command for `swarm lsp` and stdio-backed LSP tools. |
| `SWARM_LSP_PYTHON_COMMAND` / `SWARM_LSP_RUST_COMMAND` / `SWARM_LSP_GO_COMMAND` | Enable narrow stdio LSP providers for non-TypeScript workspaces. |
| `SWARM_TASK_TIMEOUT_MS` | Per-task timeout in ms. |
| `SWARM_SHELL_AUTO_BACKGROUND_MS` | Move a foreground shell command that is still running after this many ms to a background process (also `runtime.shellAutoBackgroundMs`; unset keeps foreground commands). |
| `SWARM_SUPERAGENT_HOME` | Override the ticket host's state directory (`~/.swarm/superagent`). |
| `OPENAI_API_KEY` | Environment key source for the OpenAI provider. |

## Development

```bash
npm run check     # TypeScript compilation check, no emit
npm run build     # Compile to dist/
npm run evals     # Build and run local product regression evals
npm run release:gate # Build and run the offline Claude Code parity release gate
npm run smoke     # Build and run end-to-end smoke test
```

The parity release gate is offline by default. It reports the current
operator-grade scorecard for TUI trust, cache yield, provider setup,
Gateway/Symphony control-plane evidence, LSP fallback, artifact/debug-loop
coverage, and the evidence-backed local Swarm v2 collaboration path without
calling a live provider. `node dist/evals/local-evals.js --real-swarm` covers
bugfix, feature, refactor, conflict, handoff, Symphony intake, LSP fallback, and
cache reuse scenarios with fake-provider metrics. External provider dogfood is
optional. The report also includes a regression triage queue with evidence
links, suspected owner files, and next task suggestions. The same gate is
available in the TUI with `/evals --release-gate`.

Local planning and dogfood artifacts under `.workflow/` and
`.swarm/local-tests/` are working-state evidence. Keep them local unless a task
explicitly asks for those artifacts to be published.

Package publishing/install uses the `files` allowlist in `package.json`, so
global installs include `dist/` and this README.

## Benchmark CLI

```bash
swarm bench run <suite>
swarm bench report <run_id>
swarm bench compare <run_a> <run_b>
```

Built-in suites include `ask-basic`, `repo-summary`, `small-edit`, `test-fix`,
`read-only-audit`, `delegation-roi`, and `tui-render`.

## Benchmark Wrapper

The `bench/harbor` wrapper can install a local Swarm package into an isolated
benchmark environment, forward model configuration via environment variables,
and upload report, telemetry, and trajectory artifacts.

## License

AGPL-3.0. See [LICENSE](./LICENSE). `src/superagent/` includes code adapted from
dsh-superagent-prototype under the MIT License; see
`src/superagent/LICENSE.dsh-superagent`.
