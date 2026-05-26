# Swarm TUI Renderer

Swarm now uses the CC-style Swarm-owned DOM renderer as the default and only interactive TUI renderer path. Product semantics stay in Swarm runtime modules while terminal ownership, layout, input, focus, and frame output live behind `src/tui/ui.ts`.

## Renderer Mode

- `dom-renderer`: the active renderer for all TUI facade calls.
- `legacy` and `auto` are accepted only as compatibility inputs and are normalized to `dom-renderer`.

`SWARM_TUI_RENDERER` no longer enables a legacy Ink rollback. Setting `SWARM_TUI_RENDERER=legacy`, `SWARM_TUI_RENDERER=auto`, or any unknown value still resolves to `dom-renderer`.

## Facade

- `src/tui/ui.ts` exports the TUI facade used by product code: `Box`, `Text`, hooks, `render`, renderer mode resolution, and scoped compatibility overrides.
- The facade always creates a Swarm `TuiRoot`, attaches raw stdin to the renderer input parser, writes terminal patches, and releases ownership on unmount.
- `withTuiRendererMode` remains as a compatibility helper for tests and call sites, but it no longer changes the active renderer.

## Root And Terminal Lifecycle

- `src/tui/renderer/root.ts` owns the persistent React host root, previous frame metadata, input dispatch, focus restoration, stdout/input/app contexts, and unmount behavior.
- `src/tui/renderer/terminal.ts` owns terminal lifecycle state: raw mode, cursor, alternate screen, bracketed paste, focus reporting, extended keyboard, mouse tracking, and console ownership.
- `src/tui/renderer/console-patch.ts` buffers console output while the renderer owns fullscreen terminal output, preventing runtime logs from corrupting the frame.
- `src/tui/renderer/terminal-lifecycle.test.ts` verifies ownership is reversible.

## DOM And Reconciler

- `src/tui/renderer/dom.ts` defines Swarm terminal DOM nodes with attributes, style, text, parent/child links, dirty flags, focus metadata, scroll state, event handlers, and owner-chain diagnostics.
- `src/tui/renderer/reconciler.ts` is a mutation-mode React host config. It updates host nodes in place, preserves handler storage, enforces text nesting rules, and scopes dirty propagation to changed subtrees.
- `src/tui/renderer/events/dispatcher.ts` implements DOM-like capture, target, bubble, `preventDefault`, and propagation stop semantics.

## Layout And Primitives

- `src/tui/renderer/layout.ts` computes terminal-sized layout with percent dimensions, min/max constraints, hidden nodes, wrapping, truncation, wide text, and fixed-format child bounds.
- Renderer primitives live under `src/tui/renderer/components/`: `Box`, `Text`, `RawAnsi`, `Link`, `Progress`, `ScrollBox`, `Layer`, `ModalRoot`, and `NoSelect`.
- `src/tui/display-width.ts` and renderer layout tests protect CJK/wide-cell behavior and narrow terminal wrapping.

## Screen, Diff, And Output

- `src/tui/renderer/screen.ts` stores typed screen cells with text, style, hyperlink, no-select, owner-chain, and node metadata.
- `src/tui/renderer/renderer.ts` paints DOM/layout into a screen frame and reports dirty counts, scroll drain metadata, damage rows, and screen diffs.
- `src/tui/renderer/output.ts` converts frame diffs into terminal patches. First paint uses a full reset; steady-state frames use row-level updates and OSC 8 hyperlinks only when terminal capabilities allow them.
- `src/tui/renderer/frame-snapshot.ts` records dimensions, cursor metadata, overflow checks, and cell-level diffs for regression tests.

## Raw Input And Query Responses

- `src/tui/renderer/input-parser.ts` is the byte-stream input parser. It handles text, Enter, Escape, Ctrl keys, arrows, modifiers, bracketed paste, mouse, terminal focus, terminal query responses, malformed sequences, and incomplete escape buffering.
- `src/tui/renderer/terminal-input.ts` batches parsed delivery and keeps terminal responses out of product input handlers.
- `src/tui/renderer/terminal-query.ts` isolates query response handling so prompt editing never receives terminal reports as typed text.

## Events, Focus, And Layers

- `src/tui/renderer/focus.ts` owns active node selection and focus restoration when focused DOM nodes disappear.
- `src/tui/renderer/layering.ts` and `Layer`/`ModalRoot` make modal z-order, focus ownership, and overlay routing explicit.
- Product surfaces such as approval overlays use renderer input props so overlay keys can be claimed before prompt fallback.

## Virtual Transcript And Search

- `src/tui/renderer/virtual-transcript.ts` snapshots visible transcript rows without mounting the whole history.
- `src/tui/transcript-search.ts` indexes brief, preview, and detail text; preserves active search while streaming appends; and supports wraparound navigation.
- `src/tui/message-folding.ts` keeps fold state stable by message key.
- `src/tui/tui-performance.test.ts` protects long-session append, offscreen search, fold height changes, and bounded renderer work.

## Prompt Input And Shortcut Registry

- `src/tui/chat-input-controller.ts` isolates prompt editing state from app-level command routing.
- `src/tui/input-rendering.ts`, `src/tui/slash-commands.ts`, and `src/tui/footer-navigation.ts` cover completion overlay, slash mode, footer pills, and narrow terminal row budgets.
- `src/tui/shortcuts.ts` is the registry for shortcut labels and phrases. Product result text should use helpers such as `appendDetailShortcut`, `detailOpenHint`, and `transcriptSearchHint` instead of hand-written shortcut strings.

## Design System, Dialogs, And Cockpit

- `src/tui/theme.ts` provides semantic tones and density rules for transcript rows, approvals, cache, services, status rails, and compact operator rows.
- `src/tui/components/ApprovalOverlay.tsx`, `ConversationFullscreenLayout.tsx`, `StatusRail.tsx`, `ActionLog.tsx`, and `InspectorPane.tsx` share the focus/detail/result surface contract.
- `src/tui/renderer/operator-cockpit.ts` keeps cache and LSP status visible while surfacing recovery actions in compact operator surfaces.

## Selection, Links, And Terminal Capabilities

- `src/tui/renderer/hit-test.ts` maps screen cells back to DOM owner chains, links, and no-select spans.
- `src/tui/renderer/selection.ts` extracts copy-safe selected text, excluding no-select UI chrome.
- `src/tui/renderer/terminal-capabilities.ts` gates mouse tracking, focus reporting, hyperlinks, clipboard writes, notifications, and tab status behind explicit support checks and redacted diagnostics.
- Unsupported terminals must disable these features cleanly without stealing prompt focus.

## State And Instrumentation

- `src/tui/state/*` provides selector-based TUI app state so renderer/product subscribers only fire when their selected slice changes.
- `src/tui/interaction-replay.ts` and `src/evals/local-evals.ts` provide offline replay, dogfood, and parity gate evidence.
- Renderer frame output exposes damage and repaint cost metrics for performance regressions.

## Verification

Run these checks before shipping renderer changes:

```text
node --import tsx --test "src/tui/**/*.test.ts"
node --import tsx --test src/evals/local-evals.test.ts
npm run check
npm run build
npm run release:gate
npm install -g .
swarm --version
```
