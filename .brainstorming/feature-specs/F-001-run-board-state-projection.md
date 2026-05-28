# F-001: RunBoard State Projection

Priority: P0

## Purpose

Create the canonical product projection for one run so rows, attention, preview, and final result do not each interpret runtime events differently.

## Scope

Add pure types, reducer, selectors, and event mapper under `src/tui/run-board/`. Consume existing `RuntimeEvent`, `TuiWorkState`, worker/handoff maps, loop activity, tool results, optional `WorkBoard` snapshots, and latest result card inputs. Do not require backend protocol changes.

## Owned Files

- `src/tui/run-board/run-board-types.ts`
- `src/tui/run-board/run-board-reducer.ts`
- `src/tui/run-board/run-board-selectors.ts`
- `src/tui/run-board/runtime-event-to-run-board.ts`
- `src/tui/run-board/run-board-snapshot.ts`

## Dependencies

None.

## Acceptance

- Public projection functions are testable without React.
- State carries run identity, phase, workers, attention, evidence, preview, and optional final result.
- Selectors are the only component-facing contract.
- Unknown or unsupported events are safe no-ops.

## Tests

Add reducer, selector, and mapper fixtures for empty run, worker lifecycle, failed tool, approval, blocked handoff, final success/failure, and no-worker single-agent run.
