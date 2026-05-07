# Swarm PRD

## Vision

Swarm is a versatile, self-iterating local and distributed agent swarm CLI. Users talk only to the main Swarm. Swarm decides when to answer directly, run a local coding loop, spawn workers, run a full swarm, review results, ask for clarification, or improve itself.

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
- Yolo mode is an explicit opt-in permission mode for skipping approval prompts while preserving workspace and deny-list boundaries.
- Provider support must remain multi-vendor: OpenAI-compatible, Claude-compatible, Kimi coding plan, and custom endpoints.

## Core Capabilities

- Shared Work Kernel for Swarm and Symphony: user prompts, Gateway requests, local Symphony work items, and self-iteration tasks become common work sessions with shared task graph, runner attempts, workspace leases, blackboard, artifacts, policy, review, verification, trace, and status snapshots. See `docs/WORK_KERNEL.md`.
- Local coding loop with file read/search/edit/write, shell/test/lint/git tools, permission checks, output budgets, and long-output artifact persistence.
- Web search tool with provider-native server-side search when available, local fallback search, domain filters, and source-preserving output for current information.
- Local Gateway HTTP/event-stream API for scripts, editor integrations, approval callbacks, live-message injection, and read APIs for graph, trace, audit, usage, workers, and handoffs. The product UI is the CLI TUI; Gateway is API only.
- Main Swarm control plane with structured decisions for answer, coding loop, full swarm, live-message injection, interruption, clarification, review, compacting, and self-improvement.
- Worker lifecycle with spawn, continue, stop, status, persisted worker records, tool budgets, file scope, and worker notifications.
- Agent spec registry with specialized personas for researcher, coder, reviewer, critic, verifier, architect, self-improver, and handoff specialist.
- Main-Swarm-owned dispatch: `agent.delegate` returns to the main Swarm, which uses an LLM control decision to choose agent persona and invocation mode.
- Handoff lifecycle for deeper internal work: create, observe, continue via main Swarm, take back, return, fail, and persist the task packet/result.
- Blackboard for shared facts: plans, evidence, decisions, review results, user live messages, worker state, file locks, and workspace changes.
- Artifact store for intermediate material: long tool output, worker drafts, trace snapshots, temporary patch candidates, and compacted context.
- Trace and debug logs for user input, control decisions, LLM calls, tool calls, workers, blackboard writes, permissions, review, and final output.
- Self-iteration loop: inspect recent logs/traces/artifacts, classify failure modes, generate a plan, edit Swarm, run checks, and summarize verification.

## Milestones

1. Reliable local Swarm CLI: onboarding, provider/model selection, stable TUI, coding loop, live input, trace/artifact/session inspection.
2. Local multi-agent collaboration: agent spec registry, LLM dispatch, persisted workers, handoff sessions, worker continuation/stop, richer use of the existing blackboard, reviewer/critic, file locks, read-only worker parallelism, write serialization.
3. Self-iteration: self-review command, failure taxonomy, improvement planning, eval suite, verified self-modification.
4. Work Kernel and Symphony ingress: common work/session/attempt/workspace/policy types, optional `WORKFLOW.md` loader, local/fake work sources, claim/retry/reconciliation loop, and shared status snapshots.
5. ASP protocol hardening: local Gateway, envelope-first lifecycle, idempotency, capability routing, consensus, policy, and transport abstraction.
6. Distributed Swarm: child-process/daemon workers, worktree isolation, health checks, retry-different-worker, distributed trace.

## Success Metrics

- Time from `swarm` to a verified useful workspace change.
- Percentage of tasks completed without slash commands.
- Live user input response latency.
- JSON control decision repair rate.
- Worker results accepted by reviewer.
- Tool failure recovery rate.
- Session resume success rate.
- Self-iteration changes that pass `npm run check` and `npm run build`.
