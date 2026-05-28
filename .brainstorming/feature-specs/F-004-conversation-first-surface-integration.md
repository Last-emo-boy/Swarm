# F-004: Conversation-First Surface Integration

Priority: P0

## Purpose

Make Swarm Board visible during a run without weakening the TUI's conversation-first contract.

## Scope

Integrate `RunBoardSurface` into the busy Overview body in `SwarmChatApp.tsx`. Keep chat, prompt focus, footer, status rail, `CurrentActionRow`, and approval behavior intact. Move protocol-heavy `SwarmSurfacePanel` output to detail/debug by default.

## Owned Files

- `src/tui/SwarmChatApp.tsx`
- `src/tui/run-board/RunBoardSurface.tsx`
- `src/tui/conversation-layout.ts`
- `src/tui/swarm-surface.ts`

## Dependencies

- F-001
- F-002
- F-003

## Acceptance

- Busy Overview shows Swarm Board first.
- Prompt focus is unchanged while commands run.
- Empty Enter does not open board detail.
- Existing approval overlay and detail semantics remain intact.

## Tests

Extend focus replay and visual snapshot coverage for busy Overview, explicit detail open/close, and no prompt-focus regression.
