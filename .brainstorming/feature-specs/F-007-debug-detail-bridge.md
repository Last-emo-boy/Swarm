# F-007: Debug Detail Bridge

Priority: P1

## Purpose

Keep default Swarm Board copy product-facing while preserving access to protocol evidence for advanced diagnosis.

## Scope

Expose detail refs from rows and attention items to existing debug/detail sources such as `swarm-surface.ts`, `work-board.ts`, action logs, and inspector panes. Source ids may exist in state, but not in default row labels.

## Owned Files

- `src/tui/run-board/run-board-selectors.ts`
- `src/tui/swarm-surface.ts`
- `src/runtime/work-board.ts`
- `src/tui/components/ActionLog.tsx`
- `src/tui/SwarmChatApp.tsx`

## Dependencies

- F-001
- F-004

## Acceptance

- Detail links can reveal actor, task, handoff, WorkBoard, or action-log evidence.
- Default board copy contains no internal protocol terms.
- Detail output remains bounded and searchable.

## Tests

Add selector and component tests for debug refs plus negative default-copy tests for protocol terms.
