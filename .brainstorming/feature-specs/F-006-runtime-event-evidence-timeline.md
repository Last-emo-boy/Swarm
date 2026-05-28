# F-006: Runtime Event Mapping And Evidence Timeline

Priority: P1

## Purpose

Ensure Worker Board rows, Attention Panel, timeline, and Result Preview tell the same story.

## Scope

Centralize event-to-evidence mapping and evidence ordering. Cover worker, task, handoff, approval, loop activity, tool result, review, verification, final, queue, and progress events where useful. Reuse or mirror the display-signature dedupe pattern from `src/tui/tui-event-buffer.ts`.

## Owned Files

- `src/tui/run-board/runtime-event-to-run-board.ts`
- `src/tui/run-board/run-board-reducer.ts`
- `src/tui/run-board/run-board-selectors.ts`
- `src/tui/tui-event-buffer.ts`

## Dependencies

- F-001

## Acceptance

- Duplicate display-equivalent events do not create duplicate evidence.
- Latest row evidence and attention evidence agree.
- Progress events update counters without noisy rows.
- Unknown event types are ignored safely.

## Tests

Add typed event fixtures for worker lifecycle, blocked handoff, failed tool, approval, final success/failure, queue pressure, and duplicates.
