# F-009: Terminal Mouse Interaction Layer

Priority: P1

## Purpose

Make Swarm Board clickable in capable terminals while preserving complete keyboard access.

## Scope

Use existing terminal mouse tracking, SGR mouse parsing, hit testing, and DOM event dispatch foundations. Connect parsed mouse events to root dispatch, then add click handlers for RunBoard rows, Attention actions, Result next actions, and footer/status targets.

## Terminal Model

Terminal mouse support is still raw terminal input, not a GUI event loop. Capable terminals emit escape sequences after the app enables mouse tracking. The implementation SHOULD use SGR mouse mode (`CSI ? 1006 h`) with normal tracking (`CSI ? 1000 h`), parse `CSI < button;x;y M/m`, convert terminal cells to zero-based coordinates, then dispatch through renderer hit testing.

Node TTY raw mode is required so stdin delivers those sequences to the app without line buffering. On Windows Terminal and other VT-capable hosts, virtual terminal input is the compatibility path; unsupported terminals MUST degrade to keyboard-only operation.

Sources checked during iteration:

- xterm control sequences: SGR mouse tracking mode 1006 changes mouse reports to `CSI < ... M/m` with cell coordinates and distinct press/release final bytes. <https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>
- Node.js TTY docs: `readStream.setRawMode(true)` makes stdin deliver character-by-character raw input and disables line processing/echo. <https://nodejs.org/api/tty.html#readstreamsetrawmodemode>
- Microsoft console docs: Windows console emits VT input sequences when `ENABLE_VIRTUAL_TERMINAL_INPUT` is enabled via `SetConsoleMode`, and VT behavior should gracefully degrade if unsupported. <https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences>

Implemented in this slice:

- `terminal-capabilities.ts` gates mouse with `SWARM_TUI_MOUSE !== "0"` and modern TTY detection.
- `terminal.ts` enables/disables `?1000` plus `?1006` mouse tracking with the rest of the TUI lifecycle.
- `input-parser.ts` parses SGR mouse reports into zero-based `TuiMouseInput`.
- `root.ts` dispatches left-click through DOM hit testing and applies wheel deltas to the nearest scroll region.
- `ChatInputArea` footer/status pills now expose click handlers that call the same footer detail path as keyboard navigation.
- `RunBoardSurface` rows and Attention actions remain clickable and keep keyboard equivalents.

## Owned Files

- `src/tui/renderer/terminal-input.ts`
- `src/tui/renderer/root.ts`
- `src/tui/renderer/hit-test.ts`
- `src/tui/renderer/events/click-event.ts`
- `src/tui/renderer/events/dispatcher.ts`
- `src/tui/run-board/WorkerRow.tsx`
- `src/tui/run-board/AttentionPanel.tsx`
- `src/tui/run-board/ResultPreview.tsx`
- `src/tui/SwarmChatApp.tsx`

## Dependencies

- F-002 Worker Board Rows
- F-003 Attention Panel And Exception Taxonomy
- F-004 Conversation-First Surface Integration
- F-007 Debug Detail Bridge

## Acceptance

- SGR mouse input dispatches `TuiClickEvent` to the DOM element under the clicked cell.
- Worker row click selects or opens existing detail behavior without stealing prompt focus.
- Attention action click invokes only existing supported actions.
- Wheel events scroll the active scroll region.
- `SWARM_TUI_MOUSE=0` disables the feature.
- Every pointer action has a keyboard equivalent.

## Tests

Add parser/lifecycle regression coverage, root hit-test dispatch tests, RunBoard click tests, wheel scroll tests, disabled capability tests, and focus replay tests.
