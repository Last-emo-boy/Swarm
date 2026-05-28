# F-003: Attention Panel And Exception Taxonomy

Priority: P0

## Purpose

Make exceptions actionable without turning the board into a modal stuck workflow.

## Scope

Render non-modal attention items for `slow`, `blocked`, `conflicted`, `uncertain`, `failed`, and `approval`. Each item must include condition, evidence, one recommendation, and supported controls. Existing approval overlays remain responsible for actual approval decisions.

## Owned Files

- `src/tui/run-board/AttentionPanel.tsx`
- `src/tui/run-board/run-board-selectors.ts`
- `src/tui/run-board/runtime-event-to-run-board.ts`
- `src/tui/SwarmChatApp.tsx`

## Dependencies

- F-001
- F-002

## Acceptance

- Failed tools render as failed, not generic stuck.
- Waiting dependencies render as blocked or waiting with a user-facing dependency label.
- Approval attention explains why the overlay needs a decision.
- Slow detection is threshold-based and configurable.

## Tests

Add taxonomy tests for all six attention types, recommendation presence, approval compatibility, and negative tests for protocol leakage.
