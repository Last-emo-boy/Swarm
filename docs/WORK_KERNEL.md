# Swarm And Symphony Work Kernel

Status: implemented skeleton plus next iteration plan

This document combines the ideas in `Swarm.md` and `Symphony.md` into one
architecture. The goal is not to merge the two products into one shape. The
goal is to give them a shared work kernel so interactive local agent work and
background local work-source automation use the same session, task, runner,
policy, trace, and review primitives.

## One Model, Multiple Entrypoints

Swarm and Symphony should be understood as different entrypoints into the same
work execution layer.

```text
Interactive user
  -> swarm TUI
  -> Work Kernel

Headless or integration request
  -> swarm run / Gateway API
  -> Work Kernel

Local work source
  -> Symphony daemon / work-source poller
  -> Work Kernel

Work Kernel
  -> ASP envelope, task graph, blackboard, policy, runner attempts, review, trace
  -> local coding loop, worker agents, tools
```

Swarm remains the user-facing agent runtime. Users talk to the main Swarm, and
the main Swarm decides whether to answer, run the local coding loop, delegate to
workers, ask for clarification, review, or continue.

Symphony is a background work ingress. It reads work from a local source such
as `WORK_ITEMS.md`, creates isolated workspaces, and opens Work Kernel sessions. It
should not duplicate planner, worker, blackboard, review, or trace behavior.

ASP remains the protocol and coordination layer. It defines the envelopes,
messages, routing, task graph, blackboard, review, consensus, policy, and trace
contracts used inside the Work Kernel.

## Layering

```text
L6 Human And Automation Entrypoints
   Product UI: Swarm TUI
   Headless CLI/API: swarm run, Gateway API
   Background intake: Symphony daemon

L5 Work Sources
   User prompt, live user message, HTTP session request, local work item

L4 Work Kernel
   WorkItem, WorkSession, TaskGraph, Assignment, WorkspaceLease,
   RunAttempt, Blackboard, Artifact, Review, Verification, Policy, Trace

L3 ASP Coordination
   Envelope, Registry, Router, Task messages, Review messages,
   Blackboard messages, Consensus messages, Error messages

L2 Execution
   Local coding loop, worker process, tool runner,
   shell/file/git/web/package/code tools

L1 Host Substrate
   Filesystem, SQLite, process IPC, HTTP/SSE, local source files, model providers
```

Only the Swarm TUI owns product interaction UX. Headless CLI commands, Gateway
routes, and Symphony daemons are execution or automation entrypoints. All of
them must produce the same Work Kernel records and events once work starts.

## Concept Map

| Symphony concept | Swarm / ASP concept | Shared Work Kernel concept |
| --- | --- | --- |
| Local work item | User objective / Gateway session request | `WorkItem` |
| Work-source poll tick | User turn / HTTP session creation | `WorkSource` event |
| Orchestrator state | Swarm session + task states | `WorkSessionState` |
| Claimed work item | Active session or retry reservation | `WorkClaim` |
| Run attempt | Task attempt / worker attempt | `RunAttempt` |
| Coding agent runner | Worker agent / coding loop | `Runner` |
| Per-item workspace | Workspace write boundary | `WorkspaceLease` |
| `WORKFLOW.md` | Swarm policy and prompt profile | `WorkflowPolicy` |
| Structured logs | Runtime events and trace envelopes | `WorkEvent` |
| Retry queue | Task retry and recovery suggestion | `RetryPolicy` |
| Reconciliation | Session interruption / cancellation | `Reconciliation` |
| Status surface | TUI `/kernel`, `/why`, `/workers`; Gateway read APIs | `WorkSnapshot` |

## Core Objects

### WorkItem

A normalized unit of work before execution. It can come from a user prompt, a
Gateway API request, a local Symphony work item, or a self-iteration task.

Required fields:

- `source`: `user`, `gateway`, `symphony`, or `self`.
- `source_id`: stable identifier from the local source when the record provides one.
- `human_id`: readable identifier such as `ABC-123`.
- `title`.
- `description`.
- `labels`.
- `priority`.
- `state`.
- `url`.
- `metadata`.

The Work Kernel should depend on normalized local fields rather than any
particular product's issue schema. Repository-owned Markdown, JSON, and JSONL
sources normalize into `WorkItem`. Older persisted rows may still contain
legacy identifier fields, but new local sources write `source_id`.

### WorkSession

The execution container for one WorkItem or one direct user objective.

It owns:

- the objective and source metadata,
- policy,
- task graph,
- blackboard namespace,
- artifact namespace,
- worker records,
- approval records,
- usage,
- trace,
- final outcome.

Existing `SwarmSession` is already close to this object. It should evolve into
the common session type rather than remaining only a full-swarm concept.

### TaskGraph

The structured plan for the session. It contains tasks, dependencies,
capability requirements, expected outputs, risk class, file scope, and
acceptance criteria.

The task graph supports both Swarm and Symphony:

- Swarm creates it from natural language using a structured LLM planner.
- Symphony may create a simple default graph from `WORKFLOW.md`, or let the
  main Swarm create the graph from the work item prompt.

### Assignment

An assignment binds a task to a runner mode and capability.

Examples:

- main local coding loop,
- read-only explorer worker,
- scoped writer worker,
- reviewer,
- verifier,
- local coding-loop runner,
- deterministic local tool.

Semantic assignment should be decided by structured LLM decisions when the
question is about intent, domain, or agent value. Deterministic checks should
only enforce safety, policy, scope, capacity, and idempotency.

### WorkspaceLease

The workspace lease defines where code may be read or written.

For Swarm, the default lease is the startup workspace. For Symphony, each work
item gets a deterministic per-item workspace. The same invariants apply:

- the effective working directory is validated before execution,
- write paths must stay inside the lease boundary unless policy explicitly
  allows otherwise,
- paths outside the lease are read-only by default,
- workspace keys are sanitized when derived from source identifiers,
- writer agents need a declared file scope.

### RunAttempt

A run attempt records one execution try for one session task or work item worker.

It should include:

- session id,
- task id when applicable,
- runner id,
- attempt number,
- workspace path,
- start and end times,
- status,
- terminal reason,
- last event timestamp,
- token and usage counters,
- error category,
- recovery suggestion.

Symphony's attempt lifecycle and Swarm's task attempt lifecycle should share the
same event names where possible.

### Blackboard And Artifacts

The blackboard is the short structured memory of the session: plan, evidence,
decisions, review results, worker state, user live messages, file locks, and
workspace changes.

Artifacts are for heavier material: long tool output, compacted context,
worker drafts, trace snapshots, temporary patches, and final reports.

The main Swarm reads from these stores to explain work, continue work, review
work, and produce the final answer. Symphony status surfaces read from the same
stores rather than keeping separate status truth.

### Review And Verification

Review is a first-class Work Kernel phase, not a Swarm-only feature.

For local interactive coding, review checks that the result matches the user
request and that changed files have verification. For Symphony, review checks
that the work item reached the workflow-defined handoff condition, which may be
`Human Review` rather than `Done`.

Review can return:

- `approve`,
- `needs_revision`,
- `reject`,
- `ask_human`.

Verification evidence should be written to the blackboard and referenced in the
final outcome.

## Policy Boundary

The most important split is:

- LLM decisions handle semantic control.
- Deterministic policy handles safety and scheduling.

LLM structured decisions should choose:

- route mode,
- whether parallelism has value,
- worker persona,
- review focus,
- whether more context is needed,
- whether a task should be decomposed,
- whether a result needs revision.

Deterministic policy should enforce:

- workspace boundaries,
- approval mode,
- denied capabilities,
- write serialization,
- file locks,
- concurrency limits,
- retry limits,
- idempotency,
- timeout and stall handling,
- work-source eligibility,
- terminal-state reconciliation.

This avoids hardcoded keyword routing while still keeping dangerous or
operational behavior predictable.

## Workflow Contract

`WORKFLOW.md` should become the repo-owned operating contract for background
and interactive work.

For Symphony, `WORKFLOW.md` configures local work-source polling, workspace
root, hooks, agent command, concurrency, retry, and the work item prompt
template.

For Swarm, the same file can optionally provide:

- repo-specific system guidance,
- allowed or preferred verification commands,
- handoff rules,
- review expectations,
- preferred agent specs,
- tool and approval defaults,
- branch or PR conventions.

The Work Kernel should load the workflow as policy and prompt context. Invalid
workflow config can block Symphony dispatch, but should not make ordinary Swarm
chat unusable unless the requested action depends on that invalid policy.

## Execution Flow: Interactive Swarm

```text
1. User sends natural language to main Swarm.
2. Main Swarm makes a structured route decision.
3. Work Kernel creates or resumes a WorkSession.
4. Main Swarm runs the local coding loop or creates a task graph.
5. Workers may be delegated when structured decisions justify parallel value.
6. Workers write results, evidence, and decisions to the blackboard.
7. Reviewer/verifier checks changed files and acceptance criteria.
8. Main Swarm aggregates the outcome and answers the user.
```

The user should experience one coherent main agent. Worker details are visible
through status and debug surfaces, not through direct worker chat.

## Execution Flow: Symphony

```text
1. Symphony polls the local work source and normalizes eligible records into WorkItems.
2. The scheduler claims eligible WorkItems within concurrency limits.
3. A deterministic WorkspaceLease is created or reused for each WorkItem.
4. WORKFLOW.md renders the initial objective and policy.
5. Work Kernel opens a WorkSession using the same task graph, blackboard,
   runner, review, artifact, and trace primitives as Swarm.
6. Runner events update session state, usage, status, and retry metadata.
7. Reconciliation stops or releases sessions whose work-source state changes.
8. Review determines whether the workflow-defined handoff has been reached.
```

Symphony remains a scheduler, runner, and local work-source reader. Task-source
writes are performed by the agent through approved local file tools and workflow
instructions, not by hardcoded orchestrator business logic.

## Implementation Plan

### Phase 1: Documented Common Types

Add Work Kernel types next to the existing ASP types:

- `WorkItem`
- `WorkSource`
- `WorkSession`
- `WorkspaceLease`
- `RunAttempt`
- `WorkEvent`
- `WorkflowPolicy`
- `WorkSnapshot`

Existing `SwarmSession`, `SwarmTask`, `BlackboardEntry`, `ReviewResult`, and
`SwarmPolicy` should be reused rather than replaced abruptly.

### Phase 2: Session Boundary Cleanup

Make the current local coding loop and full-swarm path both emit common
session, attempt, blackboard, artifact, usage, and trace records.

The immediate user-visible benefit is better `/why`, `/workers`, Gateway
inspection, session resume, and self-review.

### Phase 3: Workflow Loader

Implement a strict `WORKFLOW.md` loader:

- optional YAML front matter,
- markdown prompt body,
- typed defaults,
- environment indirection for selected fields,
- validation errors with stable error codes,
- dynamic reload for future sessions.

Start by using it as optional Swarm context before enabling Symphony dispatch.

### Phase 4: Symphony Skeleton

Add a background service skeleton around local work sources first:

- `WorkSource` interface,
- local Markdown/JSON/JSONL work source,
- fake work source for local tests,
- claim and retry state,
- workspace lease manager,
- reconciliation loop,
- status snapshot.

This tests scheduler semantics against repository-owned work sources.

### Phase 5: Local Runner And WorkSource Hardening

Harden the local work source, cleanup policy, daemon lifecycle, and local
runner bridge behind interfaces. All runners and sources should emit Work
Kernel events instead of custom status objects.

### Phase 6: Distributed ASP Hardening

After the local kernel is stable, harden envelope routing, idempotency,
capability routing, separate-process workers, and transport abstraction.

## Non-Goals For The First Combined Iteration

- Do not build any product UI outside the CLI/TUI before the Work Kernel is stable.
- Do not make Symphony own task-source business logic such as forced work item state
  transitions.
- Do not add bidding, auction, or distributed worker transport before local
  runner/review/retry semantics are reliable.
- Do not route by hardcoded keyword categories.
- Do not fork separate blackboard, artifact, trace, or review systems for
  Symphony.

## Design North Star

Swarm is the interactive main agent.

Symphony is the background work intake and scheduler.

ASP is the collaboration protocol.

The Work Kernel is the shared execution truth.

If a feature belongs to task state, runner attempts, workspace safety,
blackboard evidence, review, verification, retry, trace, or policy, it should
live in the Work Kernel and be reused by both Swarm and Symphony.

## Implemented Skeleton

The current codebase now has the first concrete slice of this architecture:

- Work Kernel facts are represented in protocol types: `WorkItem`,
  `WorkspaceLease`, `RunAttempt`, `WorkSessionOutcome`, and `WorkSnapshot`.
- SQLite stores persist sessions, workspace leases, run attempts, task graph
  state, blackboard entries, approvals, audit, usage, workers, handoffs, and
  traces.
- Interactive Swarm sessions create workspace leases and project runtime events
  into Work Kernel attempts, evidence, review, verification, and final outcome.
- Gateway session responses include `work_snapshot` so API users see the same
  execution truth as the TUI.
- `symphony preview` loads `WORKFLOW.md`, normalizes local or fake work-source
  records into `WorkItem`, prepares per-item workspaces, creates sessions, and writes preview
  facts to the blackboard.
- `symphony tick` is the first scheduler slice. It loads the workflow, fetches
  candidate work, applies active-state and capacity policy, claims eligible
  work, prepares a workspace lease, creates a running Work Kernel session,
  writes a scheduler `RunAttempt`, records a `task.assign` ASP envelope, and
  writes a blackboard dispatch decision.
- Symphony scheduler state can now be recovered from Work Kernel records:
  Symphony-sourced sessions, dispatch attempts, runner attempts, retry attempts,
  workspace leases, and session status. The process-local sets are treated as a
  cache, not the authoritative state.
- Retry and reconciliation are persisted as `symphony.retry` and
  `symphony.reconcile` attempts plus structured blackboard decisions, so a
  restarted Gateway or CLI tick can rebuild pending retries and release
  inactive work items.
- `WORKFLOW.md` hooks are parsed into typed runtime config and executed through
  a minimal `symphony.hook` runner. Hook execution is disabled unless the
  workspace is explicitly trusted with `SWARM_SYMPHONY_TRUST_HOOKS=1` or a
  `SWARM_TRUSTED_WORKSPACE_ROOT` boundary. Hook input is structured JSON via
  stdin and `SWARM_SYMPHONY_HOOK_INPUT`; hook output may be plain text or JSON
  with `{ "decision": "allow" | "block", "reason": "..." }`.
- Hook outcomes are Work Kernel facts: `RunAttempt` rows, blackboard entries,
  audit rows, usage wall-time events, and runtime logs. Fatal lifecycle hooks
  (`after_create`, `before_run`) block dispatch/run and schedule retry;
  `after_run` is non-fatal.
- Symphony now runs a structured preflight before dispatch. It validates
  work-source kind/path requirements, workspace root shape, hook trust posture,
  hook timeout, and prompt rendering for candidate `WorkItem`s. Errors block
  dispatch; warnings are surfaced but do not block. Preflight results are
  exposed by CLI/Gateway and persisted as Kernel attempts/audit facts.
- `symphony run-once` consumes the dispatch record through the formal
  `SymphonyRunner` interface. The current implementation,
  `LocalCodingLoopSymphonyRunner`, runs the existing local coding loop inside
  the same Work Kernel session and `WorkspaceLease`. This preserves the Symphony
  `WorkItem` source on the original session and avoids a separate Symphony
  execution model.
- `POST /v1/symphony/tick` exposes the same dispatch path through the Gateway.
  `POST /v1/symphony/run-once` or `POST /v1/symphony/tick` with
  `{"execute": true}` enables the runner bridge through the same Gateway
  scheduler.
- `symphony daemon` is the first unattended CLI entrypoint. It owns one
  long-lived scheduler instance, repeatedly calls `tick`, honors the workflow
  polling interval, supports bounded local smokes with `--max-ticks`, and can
  optionally execute dispatched work with the same `SymphonyRunner` bridge as
  `run-once`. Each daemon tick prints a compact scheduler summary and surfaces
  blocking preflight/dispatch errors directly instead of requiring users to
  inspect the database.
- Symphony status is now a shared derived surface, not a daemon-local string.
  `src/symphony/status.ts` reads Symphony-sourced Work Kernel sessions,
  `RunAttempt`s, workspace leases, and workflow policy to produce one status
  object. `symphony status`, `GET /v1/symphony/status`, and the TUI
  `/symphony` command all read that same object.
- Reconciliation now has a live cancellation path for local WorkSession runners.
  When a recovered/running work item leaves an active state, the scheduler
  calls the Runtime to interrupt that specific session, records whether a live
  stop was requested in `symphony.reconcile`, marks the session cancelled, and
  treats cancelled runner outcomes as terminal rather than retryable failures.
- Symphony dispatch now has a database-backed claim record in
  `symphony_claims`. The scheduler still keeps process-local `claimed`,
  `running`, and `retrying` sets for fast snapshots, but dispatch eligibility is
  guarded by a persisted `workflow_path + work_item_key` claim with owner,
  status, expiry, attempt, and session metadata. This reduces duplicate
  dispatch when CLI, TUI, and Gateway ticks run in different local processes.
- Terminal Symphony workspaces can now be cleaned up through a shared cleanup
  path. `symphony cleanup`, `POST /v1/symphony/cleanup`, and TUI
  `/symphony-cleanup` all use `src/symphony/cleanup.ts`. Cleanup is dry-run by
  default, only considers terminal Symphony sessions with `symphony_workspace`
  leases inside the configured workspace root, applies retention gates
  (`min_age_ms`, `keep_latest`, and optional manifest preservation), runs
  `before_remove` before removal, and records `symphony.cleanup` attempts plus
  blackboard decisions. Executing recursive workspace removal now also requires
  explicit `SWARM_SYMPHONY_CLEANUP_APPROVE=1` after the dry-run is reviewed.
- Symphony hooks still require workspace trust, and now also require explicit
  `SWARM_SYMPHONY_APPROVE_HOOKS=1` before configured shell hooks execute.
  Approval, block, duration, stdout/stderr summary, and hook decisions are
  recorded as Work Kernel approval, audit, attempt, usage, and blackboard facts.
- The TUI now anchors its current chat state as a local Work Kernel session.
  Slash command approvals, tool calls, audit rows, usage rows, attempts, and
  workspace leases use that session id, so TUI-local work is inspectable through
  `/session`, `/attempts`, `/approvals`, `/audit`, `/usage`, and `/kernel`.

This is now a minimal local daemon. `tick` creates the shared execution truth and
observable dispatch record. `run-once` proves the runner contract by executing
through the existing Runtime/CodingAgentLoop inside the leased workspace. The
CLI `symphony daemon`, Gateway-managed `/v1/symphony/daemon`, and TUI
`/symphony-start`/`/symphony-stop` use the shared local
`SymphonyDaemonManager` to make the same path persistent in one local process,
while durable scheduler recovery keeps restart semantics anchored in the local
kernel. The product UI is the CLI/TUI; Gateway is only a local API and
event-stream surface. TUI `/kernel` is the combined Swarm, Work Kernel, and
Symphony status surface over the same local facts.

## Runtime Boundary Notes

The useful runtime boundary is operational, not vendor-specific:

- Workspace trust gates executable customization. Hooks, plugin servers, helper
  commands, and project-provided environment effects should not run before the
  workspace is trusted. In Swarm/Symphony terms, hook execution belongs behind
  `WorkspaceLease` and policy checks.
- Hook outputs are structured decisions. A hook may allow, deny, block, add
  context, or pass through. Runtime control should not depend on parsing human
  strings.
- Permission hooks and user approval can race; the first authoritative decision
  wins, and the loser is cancelled or ignored. This keeps UI responsive while
  still allowing policy automation.
- Multi-session systems show capacity and per-session activity directly. The
  scheduler snapshot should expose running count, max concurrency, retry queue,
  and current session activity from Work Kernel state.
- Session identity, project identity, and current working directory are separate
  concepts. A session can move into a workspace, but history and trust should
  remain explicitly anchored.

For this repo, these map to three concrete rules:

1. Symphony hooks and local runners must validate `WorkspaceLease` before execution.
2. Scheduler, hook, approval, and runner outcomes should be written as
   structured blackboard entries, attempts, audit rows, and envelopes.
3. TUI status and Gateway read APIs should read WorkSnapshot/scheduler snapshot
   rather than bespoke runtime strings.

## Next Iteration

The next implementation slice should keep extending the TUI-first local product
without forking a separate runtime:

1. Harden the TUI `/kernel` status view into the default operator surface for
   Swarm, Work Kernel, and Symphony state.
2. Add richer local source operations behind `WorkSource`; keep source writes
   out of the scheduler unless implemented as explicit approved local tools.
3. Expand local runner cancellation/retry coverage while preserving the same
   local `WorkSession`, `RunAttempt`, and `WorkspaceLease` contracts.
