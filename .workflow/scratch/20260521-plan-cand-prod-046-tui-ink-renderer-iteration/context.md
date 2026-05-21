# CAND-PROD-046 Planning Context

This Maestro task set records the next TUI iteration after reading `E:/Playground/cc`.

Decision:
- Use the higher-upside Ink renderer / DOM-level approach instead of limiting Swarm to line-windowing only.
- Keep the work incremental: first introduce a scroll/render substrate, then migrate transcript behavior, then add overlays, search, and status surfaces on top.
- Protect current product-surface work: do not modify `.workflow/state.json`, `.workflow/.maestro/**` status files, or unrelated dirty source files during planning.

Key source references from `cc`:
- `E:/Playground/cc/src/ink/components/ScrollBox.tsx`: imperative ScrollBox API, sticky scroll, pending delta, clamp bounds, viewport culling.
- `E:/Playground/cc/src/components/VirtualMessageList.tsx`: virtual message list, height measurement, search navigation, sticky prompt tracking.
- `E:/Playground/cc/src/components/FullscreenLayout.tsx`: scrollable/bottom/overlay/modal layering, unseen divider, jump-to-bottom pill.
- `E:/Playground/cc/src/components/PromptInput/PromptInput.tsx`: input footer state, overlay gating, footer pill navigation, team/task state.
- `E:/Playground/cc/src/components/StatusNotices.tsx`: default UI noise reduction; neutral/positive status moves behind `/status`.

Current Swarm surfaces:
- `src/tui/components/ConversationFullscreenLayout.tsx`
- `src/tui/components/ConversationFirstPane.tsx`
- `src/tui/conversation-layout.ts`
- `src/tui/ChatInputArea.tsx`
- `src/tui/SwarmChatApp.tsx`

Execution note:
- This is a planned backlog only. Implementation should start with TASK-001 and verify no conflict with existing uncommitted TUI work before edits.
