# Swarm PRD

## Vision

Swarm is a local CLI/TUI-first coding agent runtime for evidence-bounded workspace work. Users talk only to the main Swarm. Swarm decides when to answer directly, run a local coding loop, spawn local workers, run the experimental full-swarm path, review results, ask for clarification, or improve itself.

Swarm is not a report generator by default. For coding and project work, the final product is real workspace changes; `.swarm/artifacts` stores intermediate outputs, long logs, worker drafts, trace snapshots, and temporary evidence.

## Users And Scenarios

- Developers use Swarm to create projects, fix bugs, refactor code, run checks, and iterate on existing repositories.
- Advanced engineers use Swarm for auditable multi-agent work with clear permissions, trace, review, and rollback context.
- Agent builders use Swarm to experiment with planner, worker, reviewer, critic, blackboard, routing, and consensus patterns.
- Swarm can self-iterate when asked to inspect recent logs, diagnose failure patterns, modify its own code, and verify the result.

## Core Product Principles

- `swarm` opens the chat TUI by default.
- The only product interface is the CLI TUI; headless CLI, Gateway, and Symphony daemon paths are execution or automation entrypoints.
- Natural language input always goes to the main Swarm, even while work is running.
- Slash commands are explicit controls, not the primary interaction model.
- LLM control decisions drive routing and interruption; hardcoded keyword routing is not the primary behavior.
- Workers never speak directly to users; worker notifications flow back to the main Swarm.
- The startup workspace is the default write boundary; paths outside that boundary are read-only unless configured.
- Yolo mode is an explicit opt-in permission mode for skipping most approval prompts while preserving workspace and deny-list boundaries; destructive `r4` shell commands still stop for confirmation unless explicitly allowed.
- Provider support must remain multi-vendor: OpenAI-compatible, Claude-compatible, Kimi coding plan, and custom endpoints.

## Core Capabilities

- Shared Work Kernel for Swarm and Symphony: user prompts, Gateway requests, local Symphony work items, and self-iteration tasks become common work sessions with shared task graph, runner attempts, workspace leases, blackboard, artifacts, policy, review, verification, trace, and status snapshots. See `docs/WORK_KERNEL.md`.
- Local coding loop with file read/search/edit/write, shell/test/lint/git tools, permission checks, output budgets, and long-output artifact persistence.
- Web search tool with provider-native server-side search when available, local fallback search, domain filters, and source-preserving output for current information.
- Local Gateway HTTP/event-stream API for scripts, editor integrations, approval callbacks, live-message injection, and read APIs for graph, trace, audit, usage, workers, and handoffs. The product UI is the CLI TUI; Gateway is API only.
- Conversation-first TUI renderer substrate with ScrollBox, message-level virtual transcript layout, render caching, sticky prompt/unseen divider behavior, footer status pills, transcript search, compact foldable tool/thinking/result rows, and explicit detail surfaces for cache, Gateway, Symphony, and LSP status.
- Main Swarm control plane with structured decisions for answer, coding loop, full swarm, live-message injection, interruption, clarification, review, compacting, and self-improvement.
- Worker lifecycle with spawn, continue, stop, status, persisted worker records, tool budgets, file scope, and worker notifications.
- Agent spec registry with specialized personas for researcher, coder, reviewer, critic, verifier, architect, self-improver, and handoff specialist.
- Main-Swarm-owned dispatch: `agent.delegate` returns to the main Swarm, which uses an LLM control decision to choose agent persona and invocation mode.
- Handoff lifecycle for deeper internal work: create, observe, continue via main Swarm, take back, return, fail, and persist the task packet/result.
- Blackboard for shared facts: plans, evidence, decisions, review results, user live messages, worker state, file locks, and workspace changes.
- Artifact store for intermediate material: long tool output, worker drafts, trace snapshots, temporary patch candidates, and compacted context.
- Trace and debug logs for user input, control decisions, LLM calls, tool calls, workers, blackboard writes, permissions, review, and final output.
- Self-iteration loop: inspect recent logs/traces/artifacts, classify failure modes, generate a plan, edit Swarm, run checks, and summarize verification.

## Current Implementation Status

The current implementation status is gated by the offline release gate
(`npm run release:gate`), which must pass without paid provider calls.

The product surface is CLI/TUI first. Headless CLI, Gateway, Symphony, and ASP
are supporting automation, background intake, and protocol surfaces. They should
be described from the user's perspective as local controls and observability,
not as separate product UIs.

- Implemented and directly tested: worker-loop contracts, Work protocol
  projections, Work contract summaries, Symphony scheduler recovery/status,
  approval report guardrails, Gateway approval live-route smoke, Gateway
  event-stream helpers, bounded Gateway checkpoint route smoke, scoped-write
  runtime integration, TUI slash command registry, TUI kernel operator surface
  formatting, Gateway run management report/watch helpers, Gateway server-level
  Symphony route smoke, Symphony WorkSource local/fake parsing and refresh
  matching, Symphony local runner terminal bookkeeping, workflow loader failure
  handling, shared Symphony status formatting, daemon lifecycle, Symphony
  cleanup, doctor reports, benchmark metadata/comparison, extension catalog
  reports, custom markdown commands, local ASP envelope/router behavior
  including blackboard query filters, bounded child-process ASP transport
  behavior, execution-router fallback policy, prompt-cache status projection,
  conversation-first TUI regression coverage including virtualized long-session
  gates, footer/status overlays, transcript search, foldable runtime rows, and
  narrow/short viewport checks, Symphony workspace boundary checks, and narrow
  LSP status/restart/logs plus TypeScript semantic fallback coverage.
- Evidence-backed local Swarm v2 collaboration is implemented for the local
  runtime surface: actor identity, mailbox delivery, task/handoff ownership,
  blackboard claim/proposal/decision flow, Gateway/Symphony/LSP participants,
  protocol debug timeline, `/swarm` workbench projection, real swarm offline
  fake-provider evals, and legacy direct-path migration audit all have source
  and test/eval anchors in the coverage matrix.
- Implemented with partial or missing focused tests: checkpoint/revert source,
  broader end-to-end session creation coverage, and broad Blackboard semantics
  beyond the tested store/router query and mutation paths.
- Deferred from this iteration: hook-race approval arbitration, broader
  checkpoint orchestration beyond the bounded Gateway checkpoint route, broader
  distributed ASP transport hardening beyond the verified local child-process
  seam, cross-host distributed network execution, complex consensus beyond the
  local protocol fixtures, external provider dogfood, and richer WorkSource write operations.

Release-ready wording should stay bounded to the verified local surface:

- "Gateway automation" means the tested local HTTP/event-stream, run, approval,
  session, worker, handoff, capability, bounded Gateway checkpoint route, and
  Symphony route surfaces.
- "Symphony" means local repository-owned work-source intake, scheduling,
  daemon, runner, status, workspace preparation, and cleanup over shared Work
  Kernel records.
- "LSP" means a narrow local semantic helper surface for status/restart/logs
  and file-level completion, hover, definition, references, symbols,
  diagnostics, code actions, rename preview, and format preview. It is not an
  IDE replacement claim.
- "ASP protocol hardening" currently means local envelope/router,
  child-process IPC forwarding/reply/progress behavior, and execution routing
  policy. Network transport, cross-host routing, distributed trace, and a new
  distributed worker model are not completed claims.
- "Swarm v2 collaboration" means the evidence-backed local Swarm v2
  collaboration path with durable actors, mailboxes, ownership, blackboard
  collaboration, source-adapter participants, protocol timeline diagnostics,
  offline real swarm evals, and legacy direct-path audit. It is not a claim that
  cross-host distributed network execution, complex consensus, or external
  provider dogfood is complete.

## Milestones

1. Reliable local Swarm CLI: onboarding, provider/model selection, stable TUI, coding loop, live input, trace/artifact/session inspection.
2. Local multi-agent collaboration: agent spec registry, LLM dispatch, persisted workers, handoff sessions, worker continuation/stop, richer use of the existing blackboard, reviewer/critic, file locks, read-only worker parallelism, write serialization.
3. Self-iteration: self-review command, failure taxonomy, improvement planning, eval suite, verified self-modification.
4. Work Kernel and Symphony ingress: common work/session/attempt/workspace/policy types, optional `WORKFLOW.md` loader, local/fake work sources, claim/retry/reconciliation loop, and shared status snapshots.
5. ASP protocol hardening: verified local envelope lifecycle, idempotency,
   capability routing, consensus, policy, execution routing, and bounded
   child-process transport behavior; broader transport abstraction remains
   bounded to future distributed work.
6. Distributed Swarm: daemon workers, worktree isolation, health checks,
   retry-different-worker, network/cross-host routing, and distributed trace
   remain planned beyond the verified local child-process seam.

## Success Metrics

- Time from `swarm` to a verified useful workspace change.
- Percentage of tasks completed without slash commands.
- Live user input response latency.
- JSON control decision repair rate.
- Worker results accepted by reviewer.
- Tool failure recovery rate.
- Session resume success rate.
- Self-iteration changes that pass `npm run check` and `npm run build`.
