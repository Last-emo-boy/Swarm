# Iteration Evidence: Swarm Board UI Design

Date: 2026-05-28

## Implemented In This Iteration

- Added Swarm Board header metadata and focus line to the RunBoard surface.
- Added footer counters for workers, blocked/stuck state, files, checks, approvals, and detail affordance.
- Adjusted Worker Row visual order toward the product prototype: status badge, user-facing label, current action, status, age, evidence.
- Made Result Preview denser so the board footer remains visible in normal viewport tests.
- Passed repo/mode/risk/session metadata from `SwarmChatApp` into RunBoard selectors.
- Added `summarizeRunBoardViewCounts` for view-level footer counts.
- Preserved click behavior for Worker Row, Attention actions, Result Preview actions, and final Result next actions.

## Evidence

Design artifacts:

- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/MASTER.md`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/design-tokens.json`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/animation-tokens.json`
- `.workflow/scratch/ui-design-swarm-board-tui-20260528/design-ref/prototypes/`
- `.brainstorming/design-ref/`

Implementation files touched in this iteration:

- `src/tui/SwarmChatApp.tsx`
- `src/tui/components/SemanticTextLine.tsx`
- `src/tui/run-board/RunBoardSurface.tsx`
- `src/tui/run-board/WorkerRow.tsx`
- `src/tui/run-board/ResultPreview.tsx`
- `src/tui/run-board/run-board-selectors.ts`
- `src/tui/run-board/run-board-types.ts`
- `src/tui/run-board/run-board-row-format.ts`
- `src/tui/run-board/run-board-surface-summary.ts`
- `src/tui/run-board/RunBoardSurface.test.tsx`
- `src/tui/run-board/run-board-row-format.test.ts`

Verification commands run:

| Command | Result |
| --- | --- |
| `node --import tsx --test src/tui/run-board/*.test.ts src/tui/run-board/*.test.tsx` | passed, 25 tests |
| `node --import tsx --test src/tui/conversation-layout.test.ts src/tui/conversation-render.test.ts src/tui/renderer/terminal-input.test.ts src/tui/renderer/root.test.ts` | passed, 98 tests |
| `npm run check` | passed |
| design JSON parse check for scratch `design-ref` JSON files | passed, 8 files |

## Current Completion Posture

The implementation has moved materially toward the requested end state:

- Active run surfaces are board-first in the TUI code path.
- The board now exposes health/status metadata without reverting to log stream.
- Attention and Result surfaces remain tied to RunBoard state.
- Mouse interactions have test coverage through DOM hit testing.

Not yet claimed complete for the full objective:

- A real installed TUI smoke is still needed after build/install to verify the global binary displays the board-first UI.
- Visual validation against the user's exact expected runtime log/screen should be repeated with the latest build.
- The workflow task list remains a plan; not every task is marked completed because release smoke and broader manual review are still pending.
