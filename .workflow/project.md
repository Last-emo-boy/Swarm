# Project: Swarm

## What This Is

Swarm is a local coding agent runtime with a CLI TUI as the primary product interface. Users talk to the main Swarm; Swarm decides whether to answer directly, run the local coding loop, delegate work, review changes, resume memory, or use extensions. The product bias is simple: finish useful workspace work, show the result first, and keep internal Work Kernel, ASP protocol, workers, Gateway, and Symphony surfaces available only when they help.

## Core Value

Complete useful workspace changes through a local coding agent loop. If everything else fails, the coding loop with file read/search/edit/write, shell/test/lint/git tools, permission checks, and result verification must work reliably.

## Requirements

### Validated

- Interactive TUI as the single product interface (`swarm` command opens chat TUI)
- Local coding loop with file, shell, test, lint, git tools
- Structured result card showing session status, changed files, checks, review, memory freshness
- Multi-provider support: OpenAI-compatible, Claude-compatible, Kimi coding plan, custom endpoints
- Permission system with ask/auto-edit/full-auto/yolo modes
- Session persistence with memory compaction and resume freshness contracts
- Local Gateway HTTP/event-stream API for automation and integrations
- Capability plane unifying built-in tools, MCP, skills, slash commands, agent specs, plugins
- Worker spawning, continuation, stop, and handoff lifecycle
- Symphony background work intake and scheduler over local work sources

### Active

- [ ] Worker-loop contract for standardized worker execution
- [ ] Approval store and live approval decision routing
- [ ] Checkpoint/resume with gateway event streams
- [ ] Sandbox policy enforcement for scoped-write workers
- [ ] Capability, MCP, plugin, and skill reports for inspection
- [ ] Run management (inspect active/recent Gateway runs)
- [ ] Doctor diagnostics for model setup, stores, extensions, and Symphony preflight
- [ ] Benchmark CLI with suites for quality regression detection
- [ ] Custom commands via markdown prompt files

### Out of Scope

- Report generation as default output — real workspace changes are the product; long logs and worker drafts stay in local state
- Direct worker-to-user communication — workers report back to the main Swarm only
- Remote/distributed Swarm — current scope is local single-machine
- Product UI beyond CLI TUI — Gateway is API only, not a product interface

## Context

Swarm is a TypeScript project targeting Node.js >= 24. It uses Ink (React-based terminal UI), the Model Context Protocol SDK, and the OpenAI-compatible API pattern for provider abstraction. The codebase follows a layered architecture: TUI → Work Kernel → Capability Plane → ASP Protocol → Symphony/Gateway.

Prior work includes three milestones completed: reliable local Swarm CLI, local multi-agent collaboration with worker/handoff lifecycle, and self-iteration capabilities. The current iteration focuses on Work Kernel and Symphony alignment with the Swarm Symphony architecture documented in `docs/WORK_KERNEL.md`.

## Constraints

- **Runtime**: Node.js >= 24.0.0 required
- **License**: AGPL-3.0
- **Architecture**: Layered — Swarm TUI → Work Kernel → Capability Plane → ASP → Symphony/Gateway
- **Provider**: Must remain multi-vendor; no single-provider lock-in
- **Safety**: Permission deny rules override everything; destructive r4 shell commands always require confirmation
- **Boundary**: Startup workspace is the default write boundary; paths outside are read-only unless configured

## Tech Stack

- **Language**: TypeScript 5.9
- **Runtime**: Node.js >= 24
- **UI Framework**: Ink 5 (React 18 for terminal UI)
- **Protocol**: Model Context Protocol SDK 1.29
- **API**: OpenAI-compatible provider pattern (openai 4.x SDK)
- **Testing**: Node.js native test runner with tsx

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| CLI TUI as sole product interface | Keep product surface simple; Gateway, Symphony are automation entrypoints only | — Active |
| Local coding loop as default execution path | Simpler and more reliable than full ASP swarm for most tasks | — Active |
| Result-first UX | Users see outcome before raw output; aligns with workspace-change bias | — Active |
| Shared Work Kernel for Swarm + Symphony | Single source of truth for sessions, attempts, leases, graph, blackboard | — Active |
| LLM-driven routing over hardcoded keywords | More flexible and natural; model decides answer/loop/swarm/chat | — Active |
| OpenAI-compatible API pattern for providers | Maximizes compatibility across vendors without per-provider SDKs | — Active |

## Stakeholders

- Developers using Swarm for daily coding tasks
- Advanced engineers needing auditable multi-agent work
- Agent builders experimenting with planner/worker/reviewer patterns

---
*Last updated: 2026-05-11 after initialization*
