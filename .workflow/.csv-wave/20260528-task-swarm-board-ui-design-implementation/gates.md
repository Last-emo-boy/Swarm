# Swarm Board TUI UI Design Implementation Gates

## Product Gates

- Active run states render board-first, not log-first.
- Idle state remains conversation-first.
- Worker Board, Attention, Result Preview, and Product Result Card are projections of the same run state.
- Stuck/slow behavior is represented by a worker row state plus inline Attention panel, not by a separate modal-only interruption.
- Product-facing labels are used by default: Main Swarm, Code Worker, Test Runner, Reviewer, Researcher, Memory Checker.
- Default board copy does not expose protocol terms such as ASP, handoff, blackboard, lease, Gateway internals, or Symphony internals.

## Interaction Gates

- Worker row click opens/selects worker detail without stealing prompt focus.
- Attention action click invokes the same handler as the visible keyboard shortcut.
- Result next action click uses the same path as the slash command or keyboard action.
- Footer/status pill click opens matching detail.
- Mouse wheel scrolls the nearest scrollable region.
- `SWARM_TUI_MOUSE=0` disables mouse behavior and leaves keyboard operation complete.
- Every pointer action has a keyboard equivalent.

## Responsive Gates

- 80 columns: board remains usable; evidence may be hidden; no overlapping text.
- 100 columns: worker rows show status, label, action, age, and evidence when room permits.
- 120 columns: matches the primary design prototypes.
- 160 columns: remains a clear vertical workroom unless an explicit detail split is open.
- Short terminal height preserves Worker Board and highest severity Attention before optional detail panels.

## Verification Commands

Recommended checks:

| Command | Expected |
| --- | --- |
| `npm run check` | pass |
| `node --import tsx --test src/tui/run-board/*.test.ts src/tui/run-board/*.test.tsx` | pass where files exist |
| `node --import tsx --test src/tui/conversation-layout.test.ts src/tui/conversation-render.test.ts` | pass |
| `node --import tsx --test src/tui/renderer/terminal-input.test.ts src/tui/renderer/root.test.ts` | pass |
| focused viewport/snapshot tests for 80, 100, 120, 160 columns | pass |

## Release Gate

Before global install or handoff:

- JSON design refs parse successfully.
- New/updated TUI tests pass.
- Broad `npm run check` passes.
- Manual or snapshot smoke confirms active UI is Swarm Board first.
- Known terminal mouse limitations are documented if the host terminal lacks VT mouse support.
