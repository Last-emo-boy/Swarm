---
title: "Architecture Constraints"
category: arch
---
# Architecture Constraints

Auto-generated from project structure. Update manually as architecture evolves.

## Module Structure
- Type: single-package
- Key modules:
  - `src/tui/` — Ink-based terminal UI (product interface)
  - `src/runtime/` — Core orchestration: orchestrator, scheduler, coding loop, events, sandbox
  - `src/protocol/` — Core domain types (SwarmEnvelope, SwarmSession, SwarmTask) and envelope factory
  - `src/providers/` — LLM provider abstraction (OpenAI SDK)
  - `src/extensions/` — Capability plane: MCP, skills, slash commands, plugins
  - `src/tools/` — Tool action types, permissions engine, local tool implementations
  - `src/storage/` — SQLite-backed stores: sessions, tasks, workers, blackboard, artifacts, approvals
  - `src/server/` — Gateway HTTP server, MCP endpoint, session view
  - `src/symphony/` — Background work intake and scheduler
  - `src/config/` — Settings types, defaults, loading/saving, provider registry
  - `src/agents/` — Worker loop contracts, child agent entry points

## Layer Boundaries

```
Layer 0: src/index.ts (CLI entry)
  |
Layer 1: src/tui/ src/sessions/ src/doctor/ (UI + command surfaces)
  |
Layer 2: src/runtime/ src/server/ src/symphony/ (Core orchestration)
  |
Layer 3: src/providers/ src/extensions/ src/tools/ src/agents/ (Capabilities)
  |
Layer 4: src/storage/ src/protocol/ src/config/ (Infrastructure)
  |
Layer 5: src/types/ (Ambient declarations)
```

## Dependency Rules
- Layers only import from lower layers or same-layer siblings
- No circular dependencies
- `src/protocol/types.ts` imported by nearly everything (pure types, no side effects)
- `src/config/settings.ts` imported by most modules (settings/configuration)
- `src/storage/*` imported by runtime and symphony layers
- `src/tools/types.ts` imported by runtime, agents, extensions
- `src/extensions/types.ts` imported by runtime, extensions

## Technology Constraints
- Runtime: Node.js >= 24.0.0
- Module system: ESM (NodeNext)
- Compiler target: ES2022
- UI framework: Ink 5 (React 18 for terminal)
- Database: SQLite via `node:sqlite`
- Provider: Multi-vendor via OpenAI-compatible API pattern
- License: AGPL-3.0

## Entries
