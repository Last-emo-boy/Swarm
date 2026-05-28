# Swarm Board TUI UI Design Implementation Task

## Purpose

Turn the Swarm Board UI design reference into an executable implementation task plan.

The product goal is to make the active TUI run feel like a local agent workroom instead of a log stream:

- Worker Board shows who is doing the work.
- Attention shows where the run is blocked, slow, conflicted, uncertain, failed, or awaiting approval.
- Result Preview shows current settlement evidence while work is running.
- Product Result Card summarizes the final outcome, workers, attention history, files, checks, risks, and next actions.

## Canonical Design Reference

Primary design reference:

- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/MASTER.md`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/design-tokens.json`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/animation-tokens.json`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/prototypes/`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/layout-templates/`

Mirrored reference for brainstorming/planning:

- `.brainstorming/design-ref/MASTER.md`
- `.brainstorming/design-ref/design-tokens.json`
- `.brainstorming/design-ref/animation-tokens.json`
- `.brainstorming/design-ref/prototypes/`
- `.brainstorming/design-ref/layout-templates/`

## Design Decision

Selected variant: Operational Workroom.

Default behavior:

- Idle: conversation-first transcript.
- Running, attention, approval, and result states: Swarm Board first.
- Trace/log output: detail/debug only.
- Mouse support: progressive enhancement; every pointer action has a keyboard equivalent.

## Current Problem To Close

The current TUI has improved foundations, but the user's product target is stricter:

- Active work must not look like only log printing.
- Busy/result surfaces must consistently route to board-first display.
- Worker rows, Attention, Result Preview, and Product Result Card must be visibly structured.
- Terminal mouse click targets must work where supported without breaking keyboard operation.

## Implementation Boundary

Backend behavior must not change. This is a TUI/front-end implementation path over existing runtime events and state.

Expected owned areas:

- `src/tui/run-board/`
- `src/tui/SwarmChatApp.tsx`
- `src/tui/conversation-layout.ts`
- `src/tui/renderer/`
- `src/tui/components/`
- focused TUI tests and snapshot/viewport tests

Do not expose internal protocol terms such as ASP, blackboard claim, handoff contract, lease participant, Gateway internals, or Symphony internals in default Worker Board copy. Those terms belong only in explicit detail/debug views.

## Task Output

This package provides:

- `tasks.csv`: implementation tasks that can be assigned to workers.
- `gates.md`: acceptance and verification gates.
- `context.md`: product/design context and source paths.
