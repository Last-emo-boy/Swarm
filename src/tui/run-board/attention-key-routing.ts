import type { AttentionAction, AttentionItemView } from "./run-board-types.js";

export function runBoardAttentionActionForKey(
  item: AttentionItemView | undefined,
  character: string | undefined,
  key: { ctrl?: boolean; meta?: boolean; return?: boolean; escape?: boolean } = {}
): AttentionAction | undefined {
  if (!item || key.ctrl || key.meta || key.return || key.escape) {
    return undefined;
  }
  const normalized = normalizeAttentionKey(character);
  if (!normalized) {
    return undefined;
  }
  return item.actions.find((action) => action.enabled !== false && action.key.toLowerCase() === normalized);
}

function normalizeAttentionKey(character: string | undefined): string {
  return character?.toLowerCase() ?? "";
}
