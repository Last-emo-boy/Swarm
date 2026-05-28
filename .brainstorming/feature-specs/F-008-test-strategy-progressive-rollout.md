# F-008: Test Strategy And Progressive Rollout

Priority: P1

## Purpose

Ship a high-visibility TUI change through small, testable rollout slices.

## Scope

Use pure projection tests first, then component viewport tests, then busy Overview integration tests, then result continuity tests. Gate default rollout behind passing checks and a conservative `RunBoardConfig` mode.

## Owned Files

- `src/tui/run-board/*.test.ts`
- `src/tui/interaction-replay.test.ts`
- `src/tui/renderer/workbench-visual-snapshot.test.ts`
- `src/tui/result-card-render.test.ts`
- `src/tui/display-width.test.ts`

## Dependencies

- F-001
- F-002
- F-003
- F-004

## Acceptance

- Viewport tests cover 80, 100, 120, and 160 columns.
- Focus replay proves busy rendering does not steal prompt focus.
- Negative tests reject protocol leakage in default UI.
- Default rollout waits for projection, render, focus, and width gates.

## Tests

Required gates: `npm run check`, focused RunBoard tests, existing renderer/result/focus tests, and viewport snapshots.
