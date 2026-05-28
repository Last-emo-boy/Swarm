# F-002: Worker Board Rows

Priority: P0

## Purpose

Answer "who is working, waiting, blocked, done, or failed?" through compact product-facing rows.

## Scope

Render rows with label, status/current action, age, dependency, evidence, risk, and supported affordance hints. Default labels must be user-facing: `Main Swarm`, `Code Worker`, `Test Runner`, `Reviewer`, `Researcher`, `Memory Checker`, or bounded custom labels.

## Owned Files

- `src/tui/run-board/WorkerBoard.tsx`
- `src/tui/run-board/WorkerRow.tsx`
- `src/tui/run-board/run-board-row-format.ts`
- `src/tui/display-width.ts`

## Dependencies

- F-001

## Acceptance

- Rows preserve who, state/action, age, and evidence at 80 columns.
- Evidence truncates before label/status/age.
- Protocol ids and internal terms stay out of default rows.
- Controls appear only when backed by existing runtime actions.

## Tests

Add row formatter and component tests at 80, 100, 120, and 160 columns, including long paths, long commands, and CJK text.
