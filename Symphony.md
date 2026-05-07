# Symphony Service Specification

Status: Draft v1 (language-agnostic)

Purpose: Define a service that orchestrates coding agents to get project work done.

## 1. Problem Statement

Symphony is a long-running local automation service that continuously reads work from a
repository-owned work source, creates an isolated workspace for each work item, and runs a coding
agent session for that item inside the workspace.

The service solves four operational problems:

- It turns work item execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-item workspaces so agent commands run only inside per-item
  workspace directories.
- It keeps the workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime
  settings with their code.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Implementations are expected to document their trust and safety posture explicitly. This
specification does not require a single approval, sandbox, or operator-confirmation policy; some
implementations may target trusted environments with a high-trust configuration, while others may
require stricter approvals or sandboxing.

Important boundary:

- Symphony is a scheduler, runner, and local work-source reader.
- Work item writes are performed through normal local file tools and the configured runtime policy.
- A successful run may end at a workflow-defined handoff state (for example `Human Review`), not
  necessarily `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll the local work source on a fixed cadence and dispatch work with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-item workspaces and preserve them across runs.
- Stop active runs when work item state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability (at minimum structured logs).
- Support restart recovery without requiring a persistent database.

### 2.2 Non-Goals

- Any product UI outside the CLI/TUI.
- Multi-tenant control plane.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to edit task lists, PRs, or handoff notes. (That logic lives in
  the workflow prompt and agent tooling.)
- Mandating strong sandbox controls beyond what the coding agent and host OS provide.
- Mandating a single default approval, sandbox, or operator-confirmation posture for all
  implementations.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Loader`
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation used by the orchestrator before dispatch.

3. `Work Source`
   - Fetches candidate local work items in active states.
   - Fetches current states for specific work item IDs (reconciliation).
   - Fetches terminal-state work items during cleanup.
   - Normalizes local Markdown, JSON, or JSONL records into a stable work item model.

4. `Orchestrator`
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which work items to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. `Workspace Manager`
   - Maps work item identifiers to workspace paths.
   - Ensures per-item workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal work items.

6. `Agent Runner`
   - Creates workspace.
   - Builds prompt from work item + workflow template.
   - Executes the local Work Kernel runner in the leased workspace.
   - Streams runner events back to the orchestrator.

7. `CLI/TUI Status Surface` (optional)
   - Presents human-readable runtime status through CLI/TUI output.

8. `Logging`
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

Symphony is easiest to port when kept in these layers:

1. `Policy Layer` (repo-defined)
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for task handling, validation, and handoff.

2. `Configuration Layer` (typed getters)
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. `Coordination Layer` (orchestrator)
   - Polling loop, work item eligibility, concurrency, retries, reconciliation.

4. `Execution Layer` (workspace + agent subprocess)
   - Filesystem lifecycle, workspace preparation, local runner contract.

5. `Work Source Layer` (local by default)
   - Local file reads and normalization for work item data.

6. `Observability Layer` (logs + optional status surface)
   - Operator visibility into orchestrator and agent behavior.

### 3.3 Dependencies

- Local work source file, defaulting to `WORK_ITEMS.md`.
- Local filesystem for workspaces and logs.
- Optional workspace population tooling (for example Git CLI, if used).
- Local Swarm runtime with a Work Kernel runner such as `LocalCodingLoopSymphonyRunner`.
- Host environment authentication for the coding agent when the selected model provider requires it.

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Work Item

Normalized work item record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable work-source ID.
- `identifier` (string)
  - Human-readable work item key (example: `LOCAL-123`).
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority in dispatch sorting.
- `state` (string)
  - Current work item state name.
- `branch_name` (string or null)
  - Source-provided branch metadata if available.
- `url` (string or null)
- `labels` (list of strings)
  - Normalized to lowercase.
- `blocked_by` (list of blocker refs)
  - Each blocker ref contains:
    - `id` (string or null)
    - `identifier` (string or null)
    - `state` (string or null)
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal work item states
- concurrency limits
- local runner limits and timeouts
- workspace hooks

#### 4.1.4 Workspace

Filesystem workspace assigned to one work item identifier.

Fields (logical):

- `path` (workspace path; current runtime typically uses absolute paths, but relative roots are
  possible if configured without path separators)
- `workspace_key` (sanitized work item identifier)
- `created_now` (boolean, used to gate `after_create` hook)

#### 4.1.5 Run Attempt

One execution attempt for one work item.

Fields (logical):

- `work_item_id`
- `work_item_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)

#### 4.1.6 Live Session (Agent Session Metadata)

State tracked while a local runner is executing.

Fields:

- `session_id` (string)
- `runner_id` (string)
- `last_runner_event` (string/enum or null)
- `last_runner_timestamp` (timestamp or null)
- `last_runner_message` (summarized payload)
- `input_tokens` (integer)
- `output_tokens` (integer)
- `total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - Number of local runner turns started within the current worker lifetime.

#### 4.1.7 Retry Entry

Scheduled retry state for a work item.

Fields:

- `work_item_id`
- `identifier` (best-effort human ID for status surfaces/logs)
- `attempt` (integer, 1-based for retry queue)
- `due_at_ms` (monotonic clock timestamp)
- `timer_handle` (runtime-specific timer reference)
- `error` (string or null)

#### 4.1.8 Orchestrator Runtime State

Single authoritative in-memory state owned by the orchestrator.

Fields:

- `poll_interval_ms` (current effective poll interval)
- `max_concurrent_agents` (current effective global concurrency limit)
- `running` (map `work_item_id -> running entry`)
- `claimed` (set of work item IDs reserved/running/retrying)
- `retry_attempts` (map `work_item_id -> RetryEntry`)
- `completed` (set of work item IDs; bookkeeping only, not dispatch gating)
- `usage_totals` (aggregate tokens + runtime seconds)
- `rate_limits` (latest rate-limit snapshot from runner/provider events)

### 4.2 Stable Identifiers and Normalization Rules

- `Work Item ID`
  - Use for local source lookups and internal map keys.
- `Work Item Identifier`
  - Use for human-readable logs and workspace naming.
- `Workspace Key`
  - Derive from the work item identifier by replacing any character not in `[A-Za-z0-9._-]` with `_`.
  - Use the sanitized value for the workspace directory name.
- `Normalized Work Item State`
  - Compare states after `lowercase`.
- `Session ID`
  - Use the Work Kernel session ID created for the work item dispatch.

## 5. Workflow Specification (Repository Contract)

### 5.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

Loader behavior:

- If the file cannot be read, return `missing_workflow_file` error.
- The workflow file is expected to be repository-owned and version-controlled.

### 5.2 File Format

`WORKFLOW.md` is a Markdown file with optional YAML front matter.

Design note:

- `WORKFLOW.md` should be self-contained enough to describe and run different workflows (prompt,
  runtime settings, hooks, and work source selection/config) without requiring out-of-band
  service-specific configuration.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter must decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

### 5.3 Front Matter Schema

Top-level keys:

- `work_source`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `runner`
- `cleanup`

Unknown keys should be ignored for forward compatibility.

Note:

- The workflow front matter is extensible. Optional extensions may define additional top-level keys
  (for example `server`) without changing the core schema above.
- Extensions should document their field schema, defaults, validation rules, and whether changes
  apply dynamically or require restart.
- Optional HTTP APIs are implementation entrypoints, not workflow requirements.

#### 5.3.1 `work_source` (object)

Fields:

- `kind` (string)
  - Default and primary supported value: `local`
  - `fake` is allowed for deterministic tests and demos only.
- `path` (string)
  - Local work item source path.
  - Default: `WORK_ITEMS.md` in the current working directory.
  - Supports Markdown checklist, JSON array/object-with-`items`, or JSONL.
- `active_states` (list of strings)
  - Default: `Todo`, `In Progress`
- `terminal_states` (list of strings)
  - Default: `Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

Core Symphony is local-first. The core product reads repository-owned files through this
`work_source` contract. Dispatch, refresh, and reconciliation are local file operations backed by
the Work Kernel; synchronization with any outside system is out of the core scheduler and must be
implemented as an explicit local tool that edits the repository-owned source under normal policy.

#### 5.3.2 `polling` (object)

Fields:

- `interval_ms` (integer or string integer)
  - Default: `30000`
  - Changes should be re-applied at runtime and affect future tick scheduling without restart.

#### 5.3.3 `workspace` (object)

Fields:

- `root` (path string or `$VAR`)
  - Default: `<system-temp>/symphony_workspaces`
  - `~` and strings containing path separators are expanded.
  - Bare strings without path separators are preserved as-is (relative roots are allowed but
    discouraged).

#### 5.3.4 `hooks` (object)

Fields:

- `after_create` (multiline shell script string, optional)
  - Runs only when a workspace directory is newly created.
  - Failure aborts workspace creation.
- `before_run` (multiline shell script string, optional)
  - Runs before each agent attempt after workspace preparation and before launching the coding
    agent.
  - Failure aborts the current attempt.
- `after_run` (multiline shell script string, optional)
  - Runs after each agent attempt (success, failure, timeout, or cancellation) once the workspace
    exists.
  - Failure is logged but ignored.
- `before_remove` (multiline shell script string, optional)
  - Runs before workspace deletion if the directory exists.
  - Failure is logged but ignored; cleanup still proceeds.
- `timeout_ms` (integer, optional)
  - Default: `60000`
  - Applies to all workspace hooks.
  - Non-positive values should be treated as invalid and fall back to the default.
  - Changes should be re-applied at runtime for future hook executions.

#### 5.3.5 `agent` (object)

Fields:

- `max_concurrent_agents` (integer or string integer)
  - Default: `10`
  - Changes should be re-applied at runtime and affect subsequent dispatch decisions.
- `max_retry_backoff_ms` (integer or string integer)
  - Default: `300000` (5 minutes)
  - Changes should be re-applied at runtime and affect future retry scheduling.
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - Default: empty map.
  - State keys are normalized (`lowercase`) for lookup.
  - Invalid entries (non-positive or non-numeric) are ignored.

#### 5.3.6 `runner` (object)

Fields:

- `kind` (string)
  - Default: `local_coding_loop`.
  - Core Symphony uses the local Swarm Work Kernel runner.
  - Other runner kinds are extensions and must still obey the same `WorkspaceLease`,
    `RunAttempt`, approval, audit, and blackboard contracts.
- `max_turns` (integer)
  - Default: implementation-defined; the current CLI may override it with `--max-turns`.
- `max_tool_calls` (integer)
  - Default: implementation-defined; the current CLI may override it with `--max-tool-calls`.
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.

### 5.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-item prompt template.

Rendering requirements:

- Use a strict template engine (Liquid-compatible semantics are sufficient).
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.

Template input variables:

- `issue` (object)
  - Compatibility alias for the normalized work item fields, including labels and blockers.
- `item` / `work_item` (object)
  - Preferred aliases for the same normalized work item fields.
- `attempt` (integer or null)
  - `null`/absent on first attempt.
  - Integer on retry or continuation run.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime may use a minimal default prompt
  (`You are working on a local Symphony work item.`).
- Workflow file read/parse failures are configuration/validation errors and should not silently fall
  back to a prompt.

### 5.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error` (during prompt rendering)
- `template_render_error` (unknown variable/filter, invalid interpolation)

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

## 6. Configuration Specification

### 6.1 Source Precedence and Resolution Semantics

Configuration precedence:

1. Workflow file path selection (runtime setting -> cwd default).
2. YAML front matter values.
3. Environment indirection via `$VAR_NAME` inside selected YAML values.
4. Built-in defaults.

Value coercion semantics:

- Path/command fields support:
  - `~` home expansion
  - `$VAR` expansion for env-backed path values
  - Apply expansion only to values intended to be local filesystem paths; do not rewrite URIs or
    arbitrary shell command strings.

### 6.2 Dynamic Reload Semantics

Dynamic reload is required:

- The software should watch `WORKFLOW.md` for changes.
- On change, it should re-read and re-apply workflow config and prompt template without restart.
- The software should attempt to adjust live behavior to the new config (for example polling
  cadence, concurrency limits, active/terminal states, runner settings, workspace paths/hooks, and
  prompt content for future runs).
- Reloaded config applies to future dispatch, retry scheduling, reconciliation decisions, hook
  execution, and agent launches.
- Implementations are not required to restart in-flight agent sessions automatically when config
  changes.
- Extensions that manage their own listeners/resources (for example an HTTP server port change) may
  require restart unless the implementation explicitly supports live rebind.
- Implementations should also re-validate/reload defensively during runtime operations (for example
  before dispatch) in case filesystem watch events are missed.
- Invalid reloads should not crash the service; keep operating with the last known good effective
  configuration and emit an operator-visible error.

### 6.3 Dispatch Preflight Validation

This validation is a scheduler preflight run before attempting to dispatch new work. It validates
the workflow/config needed to poll and launch workers, not a full audit of all possible workflow
behavior.

Startup validation:

- Validate configuration before starting the scheduling loop.
- If startup validation fails, fail startup and emit an operator-visible error.

Per-tick dispatch validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an
  operator-visible error.

Validation checks:

- Workflow file can be loaded and parsed.
- `work_source.kind` is present and supported.
- `work_source.path` resolves to a local path when `work_source.kind=local`.
- `runner.kind` is supported when present.

### 6.4 Config Fields Summary (Cheat Sheet)

This section is intentionally redundant so a coding agent can implement the config layer quickly.

- `work_source.kind`: string, default `local`; `fake` is for deterministic tests and demos
- `work_source.path`: path, default `WORK_ITEMS.md`; supports Markdown checklist, JSON, and JSONL
- `work_source.active_states`: list of strings, default `["Todo", "In Progress"]`
- `work_source.terminal_states`: list of strings, default `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_retry_backoff_ms`: integer, default `300000` (5m)
- `agent.max_concurrent_agents_by_state`: map of positive integers, default `{}`
- `runner.kind`: string, default `local_coding_loop`
- `runner.max_turns`: integer, optional
- `runner.max_tool_calls`: integer, optional
- `runner.turn_timeout_ms`: integer, default `3600000`
- `runner.stall_timeout_ms`: integer, default `300000`

#### 5.3.7 `cleanup` (object)

Fields:

- `retention.min_age_ms` (integer)
  - Default: `0`
  - Terminal workspaces younger than this age are skipped with `retention_min_age`.
- `retention.keep_latest` (integer)
  - Default: `0`
  - The most recently updated N terminal Symphony sessions are skipped with `retention_keep_latest`.
- `retention.preserve_artifacts` (boolean)
  - Default: `false`
  - When true, cleanup writes a manifest artifact before removing a workspace.

## 7. Orchestration State Machine

The orchestrator is the only component that mutates scheduling state. All worker outcomes are
reported back to it and converted into explicit state transitions.

### 7.1 Work Item Orchestration States

This is not the same as source states (`Todo`, `In Progress`, etc.). This is the service's internal
claim state.

1. `Unclaimed`
   - Work item is not running and has no retry scheduled.

2. `Claimed`
   - Orchestrator has reserved the work item to prevent duplicate dispatch.
   - In practice, claimed items are either `Running` or `RetryQueued`.

3. `Running`
   - Worker task exists and the work item is tracked in `running` map.

4. `RetryQueued`
   - Worker is not running, but a retry timer exists in `retry_attempts`.

5. `Released`
   - Claim removed because the work item is terminal, non-active, missing, or retry path completed without
     re-dispatch.

Important nuance:

- A successful worker exit does not mean the work item is done forever.
- The worker may continue through multiple back-to-back local runner turns before it exits.
- After each normal turn completion, the worker re-checks the source item state.
- If the item is still in an active state, the worker may start another local runner turn in the
  same workspace, up to `runner.max_turns`.
- The first turn should use the full rendered task prompt.
- Continuation turns should send only continuation guidance to the existing thread, not resend the
  original task prompt that is already present in thread history.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry
  (about 1 second) so it can re-check whether the item remains active and needs another worker
  session.

### 7.2 Run Attempt Lifecycle

A run attempt transitions through these phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `StartingRunner`
4. `ExecutingSession`
5. `StreamingEvents`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

Distinct terminal reasons are important because retry logic and logs differ.

### 7.3 Transition Triggers

- `Poll Tick`
  - Reconcile active runs.
  - Validate config.
  - Fetch candidate work items.
  - Dispatch until slots are exhausted.

- `Worker Exit (normal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule continuation retry (attempt `1`) after the worker exhausts or finishes its in-process
    turn loop.

- `Worker Exit (abnormal)`
  - Remove running entry.
  - Update aggregate runtime totals.
  - Schedule exponential-backoff retry.

- `Runner Update Event`
  - Update live session fields, token counters, rate limits, and last activity timestamp.

- `Retry Timer Fired`
  - Re-fetch active candidates and attempt re-dispatch, or release claim if no longer eligible.

- `Reconciliation State Refresh`
  - Stop runs whose work item states are terminal or no longer active.

- `Stall Timeout`
  - Kill worker and schedule retry.

### 7.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority to avoid duplicate dispatch.
- `claimed` and `running` checks are required before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is Work Kernel-driven and filesystem-driven.
- Startup terminal cleanup removes stale workspaces for items already in terminal states.

## 8. Polling, Scheduling, and Reconciliation

### 8.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and
then repeats every `polling.interval_ms`.

The effective poll interval should be updated when workflow config changes are re-applied.

Tick sequence:

1. Reconcile running work items.
2. Run dispatch preflight validation.
3. Fetch candidate work items from the configured local work source using active states.
4. Sort work items by dispatch priority.
5. Dispatch eligible work items while slots remain.
6. Notify observability/status consumers of state changes.

If per-tick validation fails, dispatch is skipped for that tick, but reconciliation still happens
first.

### 8.2 Candidate Selection Rules

An item is dispatch-eligible only if all are true:

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-state concurrency slots are available.
- Blocker rule for `Todo` state passes:
  - If the item state is `Todo`, do not dispatch when any blocker is non-terminal.

Sorting order (stable intent):

1. `priority` ascending (1..4 are preferred; null/unknown sorts last)
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 8.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state limit:

- `max_concurrent_agents_by_state[state]` if present (state key normalized)
- otherwise fallback to global limit

The runtime counts items by their current source state in the `running` map.

### 8.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same work item.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Normal continuation retries after a clean worker exit use a short fixed delay of `1000` ms.
- Failure-driven retries use `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.
- Power is capped by the configured max retry backoff (default `300000` / 5m).

Retry handling behavior:

1. Fetch active candidate work items (not all items).
2. Find the specific item by `work_item_id`.
3. If not found, release claim.
4. If found and still candidate-eligible:
   - Dispatch if slots are available.
   - Otherwise requeue with error `no available orchestrator slots`.
5. If found but no longer active, release claim.

Note:

- Terminal-state workspace cleanup is handled by startup cleanup and active-run reconciliation
  (including terminal transitions for currently running items).
- Retry handling mainly operates on active candidates and releases claims when the item is absent,
  rather than performing terminal cleanup itself.

### 8.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running work item, compute `elapsed_ms` since:
  - `last_runner_timestamp` if any event has been seen, else
  - `started_at`
- If `elapsed_ms > runner.stall_timeout_ms`, terminate the worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection entirely.

Part B: Work source state refresh

- Fetch current item states for all running work item IDs.
- For each running item:
  - If source state is terminal: terminate worker and clean workspace.
  - If source state is still active: update the in-memory work item snapshot.
  - If source state is neither active nor terminal: terminate worker without workspace cleanup.
- If state refresh fails, keep workers running and try again on the next tick.

### 8.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Read local work items in terminal states.
2. For each terminal item identifier, remove the corresponding workspace directory when cleanup is enabled.
3. If terminal item read fails, log a warning and continue startup.

This prevents stale terminal workspaces from accumulating after restarts.

## 9. Workspace Management and Safety

### 9.1 Workspace Layout

Workspace root:

- `workspace.root` (normalized path; the current config layer expands path-like values and preserves
  bare relative names)

Per-item workspace path:

- `<workspace.root>/<sanitized_work_item_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same work item.
- Successful runs do not auto-delete workspaces.

### 9.2 Workspace Creation and Reuse

Input: `work_item.identifier`

Algorithm summary:

1. Sanitize identifier to `workspace_key`.
2. Compute workspace path under workspace root.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now=true` only if the directory was created during this call; otherwise
   `created_now=false`.
5. If `created_now=true`, run `after_create` hook if configured.

Notes:

- This section does not assume any specific repository/VCS workflow.
- Workspace preparation beyond directory creation (for example dependency bootstrap, checkout/sync,
  code generation) is implementation-defined and is typically handled via hooks.

### 9.3 Optional Workspace Population (Implementation-Defined)

The spec does not require any built-in VCS or repository bootstrap behavior.

Implementations may populate or synchronize the workspace using implementation-defined logic and/or
hooks (for example `after_create` and/or `before_run`).

Failure handling:

- Workspace population/synchronization failures return an error for the current attempt.
- If failure happens while creating a brand-new workspace, implementations may remove the partially
  prepared directory.
- Reused workspaces should not be destructively reset on population failure unless that policy is
  explicitly chosen and documented.

### 9.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in a local shell context appropriate to the host OS, with the workspace directory as
  `cwd`.
- On POSIX systems, `sh -lc <script>` (or a stricter equivalent such as `bash -lc <script>`) is a
  conforming default.
- Hook timeout uses `hooks.timeout_ms`; default: `60000 ms`.
- Log hook start, failures, and timeouts.

Failure semantics:

- `after_create` failure or timeout is fatal to workspace creation.
- `before_run` failure or timeout is fatal to the current run attempt.
- `after_run` failure or timeout is logged and ignored.
- `before_remove` failure or timeout is logged and ignored.

### 9.5 Safety Invariants

This is the most important portability constraint.

Invariant 1: Run the local runner only in the per-item workspace path.

- Before launching the local runner, validate:
  - `cwd == workspace_path`

Invariant 2: Workspace path must stay inside workspace root.

- Normalize both paths to absolute.
- Require `workspace_path` to have `workspace_root` as a prefix directory.
- Reject any path outside the workspace root.

Invariant 3: Workspace key is sanitized.

- Only `[A-Za-z0-9._-]` allowed in workspace directory names.
- Replace all other characters with `_`.

## 10. Agent Runner Protocol (Local Work Kernel Integration)

This section defines the core local contract between Symphony and the shared Work Kernel.

The default runner is the local Swarm coding loop. In this implementation the concrete adapter is
`LocalCodingLoopSymphonyRunner`, which calls `Runtime.executeWorkSession` using the Symphony-created
`WorkSession`, rendered prompt, and `WorkspaceLease`.

### 10.1 Runner Input

The scheduler passes a dispatch record to the runner:

- `work_item`
- `session`
- `workspace_path`
- `prompt`
- `attempt`
- optional execution limits such as `max_turns` and `max_tool_calls`

The runner must reject or skip dispatch records that do not contain both a session and a rendered
prompt.

### 10.2 Execution Contract

The runner must:

1. Validate that the workspace path is the active write boundary.
2. Execute the local Work Kernel session in that workspace.
3. Stream runtime events through the same event bus used by interactive Swarm.
4. Persist a `RunAttempt` with `task_id="symphony.runner"`.
5. Write a blackboard entry for completion, failure, or cancellation.
6. Return a normalized run record with `completed`, `failed`, `skipped`, or `cancelled`.

The runner should not maintain a separate task graph, blackboard, approval system, usage store, or
trace model. Those are Work Kernel responsibilities.

### 10.3 Approval, Tools, and User Input

Approval, sandbox, and user-input behavior follows the same policy as interactive Swarm:

- Tool calls use the local tool runner and permission policy.
- Approval requests are surfaced through the active CLI/TUI. Gateway approval routes are API-only integration surfaces.
- Yolo/full-auto modes may skip prompts, but must still respect workspace boundaries and deny lists.
- If unattended Symphony execution requires human input and no approval path is available, the
  runner should fail the attempt with a retryable or operator-actionable reason.

### 10.4 Cancellation and Reconciliation

When the local work source changes state, the scheduler may call the runtime to interrupt the
specific `WorkSession`.

Required behavior:

- Record whether a live stop was requested.
- Mark the Work Kernel session cancelled when reconciliation invalidates the work item.
- Treat cancelled runner outcomes as terminal for that dispatch.
- Do not retry cancellation caused by a source item leaving active states.

### 10.5 Timeouts and Error Mapping

Timeouts:

- `runner.turn_timeout_ms`: total runner turn timeout.
- `runner.stall_timeout_ms`: enforced by the scheduler based on last runner activity.

Recommended normalized error categories:

- `MODEL_NOT_CONFIGURED`
- `PERMISSION_REQUIRED`
- `RUNNER_FAILED`
- `INVALID_WORKSPACE_CWD`
- `TURN_TIMEOUT`
- `STALL_TIMEOUT`
- `CANCELLED_BY_RECONCILIATION`

### 10.6 Extension Runners

Other runner implementations may exist, including separate local processes or remote workers, but
they are not the core product path. Extensions must preserve the Work Kernel contract:

- Use the scheduler-created `WorkSession`.
- Use a validated `WorkspaceLease`.
- Persist `RunAttempt`, blackboard, audit, usage, and trace facts.
- Surface status through the same CLI/TUI status views.
- Avoid hidden mutation of the local work source.

Note:

- Workspaces are intentionally preserved after successful runs.

## 11. Local Work Source Contract

### 11.1 Required Operations

The core implementation must support these local work source operations:

1. `fetch_candidate_items()`
   - Read the configured local source and return items in active states.

2. `refresh_item_states(ids)`
   - Re-read the local source and return current states for known item IDs.
   - This is used for reconciliation and cancellation.

3. `list_terminal_items()`
   - Return terminal local items for workspace cleanup and status surfaces.

### 11.2 Local Source Formats

The default source is `WORK_ITEMS.md`.

Markdown checklist format:

```markdown
- [ ] LOCAL-1: Implement local task intake
- [ ] LOCAL-2: Add status surface
- [x] LOCAL-3: Completed item
```

Rules:

- Unchecked items map to state `Todo`.
- Checked items map to state `Done`.
- A leading `ABC-123:` or `ABC-123 -` token becomes the identifier.
- Missing identifiers are generated as `LOCAL-N`.

JSON format:

```json
{
  "items": [
    {
      "id": "local-1",
      "identifier": "LOCAL-1",
      "title": "Implement local task intake",
      "state": "Todo",
      "priority": 2,
      "labels": ["symphony"]
    }
  ]
}
```

JSONL format uses one JSON object per line with the same fields.

### 11.3 Normalization Rules

Candidate item normalization should produce the domain fields listed in Section 4.1.1.

Additional normalization details:

- `labels` -> lowercase strings
- `priority` -> integer only; non-integers become null
- `created_at` and `updated_at` -> ISO-8601 strings when present
- `metadata.work_source_kind` -> `local`
- `metadata.local_path` should identify the source file when available

### 11.4 Error Handling Contract

Recommended error categories:

- `unsupported_work_source_kind`
- `missing_local_work_source`
- `local_work_source_parse_error`
- `local_work_source_unknown_payload`

Orchestrator behavior on local source errors:

- Candidate fetch failure: log and skip dispatch for this tick.
- Running-state refresh failure: log and keep active workers running.
- Cleanup source read failure: log warning and continue with Work Kernel terminal sessions.

### 11.5 Work Item Writes

Core Symphony does not need to mutate the task source automatically.

- The scheduler reads local work items and owns Work Kernel state.
- Agents may edit `WORK_ITEMS.md` only through normal file tools and permission policy.
- State transitions should be explicit workspace changes, not hidden scheduler side effects.
- This keeps task intake reproducible, diffable, and local-first.

## 12. Prompt Construction and Context Assembly

### 12.1 Inputs

Inputs to prompt rendering:

- `workflow.prompt_template`
- normalized `work_item` object (`issue` remains a template compatibility alias)
- optional `attempt` integer (retry/continuation metadata)

### 12.2 Rendering Rules

- Render with strict variable checking.
- Render with strict filter checking.
- Convert work item object keys to strings for template compatibility.
- Preserve nested arrays/maps (labels, blockers) so templates can iterate.

### 12.3 Retry/Continuation Semantics

`attempt` should be passed to the template because the workflow prompt may provide different
instructions for:

- first run (`attempt` null or absent)
- continuation run after a successful prior session
- retry after error/timeout/stall

### 12.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure and decide retry behavior.

## 13. Logging, Status, and Observability

### 13.1 Logging Conventions

Required context fields for work item-related logs:

- `work_item_id`
- `work_item_identifier`

Required context for local runner session lifecycle logs:

- `session_id`

Message formatting requirements:

- Use stable `key=value` phrasing.
- Include action outcome (`completed`, `failed`, `retrying`, etc.).
- Include concise failure reason when present.
- Avoid logging large raw payloads unless necessary.

### 13.2 Logging Outputs and Sinks

The spec does not prescribe where logs must go (stderr, local file, Gateway event stream, etc.).

Requirements:

- Operators must be able to see startup/validation/dispatch failures without attaching a debugger.
- Implementations may write to one or more sinks.
- If a configured log sink fails, the service should continue running when possible and emit an
  operator-visible warning through any remaining sink.

### 13.3 Runtime Snapshot / Monitoring Interface (Optional but Recommended)

If the implementation exposes a synchronous runtime snapshot for CLI/TUI status or monitoring, it
should return:

- `running` (list of running session rows)
- each running row should include `turn_count`
- `retrying` (list of retry queue rows)
- `usage_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running` (aggregate runtime seconds as of snapshot time, including active sessions)
- `rate_limits` (latest runner/provider rate limit payload, if available)

Recommended snapshot error modes:

- `timeout`
- `unavailable`

### 13.4 Optional Human-Readable CLI/TUI Status Surface

A human-readable CLI/TUI status surface is optional and implementation-defined.

If present, it should draw from orchestrator state/metrics only and must not be required for
correctness.

### 13.5 Session Metrics and Token Accounting

Token accounting rules:

- Agent events may include token counts in multiple payload shapes.
- Prefer absolute thread totals when available, such as:
  - `thread/tokenUsage/updated` payloads
  - `total_token_usage` within token-count wrapper events
- Ignore delta-style payloads such as `last_token_usage` for status totals.
- Extract input/output/total token counts leniently from common field names within the selected
  payload.
- For absolute totals, track deltas relative to last reported totals to avoid double-counting.
- Do not treat generic `usage` maps as cumulative totals unless the event type defines them that
  way.
- Accumulate aggregate totals in orchestrator state.

Runtime accounting:

- Runtime should be reported as a live aggregate at snapshot/render time.
- Implementations may maintain a cumulative counter for ended sessions and add active-session
  elapsed time derived from `running` entries (for example `started_at`) when producing a
  snapshot/status view.
- Add run duration seconds to the cumulative ended-session runtime when a session ends (normal exit
  or cancellation/termination).
- Continuous background ticking of runtime totals is not required.

Rate-limit tracking:

- Track the latest rate-limit payload seen in any agent update.
- Any human-readable presentation of rate-limit data is implementation-defined.

### 13.6 Humanized Agent Event Summaries (Optional)

Humanized summaries of raw agent protocol events are optional.

If implemented:

- Treat them as observability-only output.
- Do not make orchestrator logic depend on humanized strings.


