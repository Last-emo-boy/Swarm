export type TuiShortcutId =
  | "prompt.shortcuts"
  | "detail.open"
  | "detail.preflight"
  | "detail.views"
  | "detail.providers"
  | "detail.list"
  | "detail.instructions"
  | "detail.contents"
  | "detail.rendered_messages"
  | "search.jump"
  | "command.select"
  | "command.accept"
  | "command.close"
  | "approval.approve_once"
  | "approval.allow_target"
  | "approval.deny"
  | "approval.cancel"
  | "action.select"
  | "action.details"
  | "action.page"
  | "run-board.toggle_rail";

export type TuiShortcut = {
  id: TuiShortcutId;
  keys: readonly string[];
  label: string;
  scope: "global" | "prompt" | "command" | "approval" | "action";
};

export const TUI_SHORTCUTS: Readonly<Record<TuiShortcutId, TuiShortcut>> = Object.freeze({
  "prompt.shortcuts": {
    id: "prompt.shortcuts",
    keys: ["?"],
    label: "? for shortcuts",
    scope: "prompt"
  },
  "detail.open": {
    id: "detail.open",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.preflight": {
    id: "detail.preflight",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.views": {
    id: "detail.views",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.providers": {
    id: "detail.providers",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.list": {
    id: "detail.list",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.instructions": {
    id: "detail.instructions",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.contents": {
    id: "detail.contents",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "detail.rendered_messages": {
    id: "detail.rendered_messages",
    keys: ["Ctrl+O"],
    label: "Ctrl+O",
    scope: "global"
  },
  "search.jump": {
    id: "search.jump",
    keys: ["Enter"],
    label: "Enter jump",
    scope: "global"
  },
  "command.select": {
    id: "command.select",
    keys: ["Up", "Down"],
    label: "Up/Down select",
    scope: "command"
  },
  "command.accept": {
    id: "command.accept",
    keys: ["Tab"],
    label: "Tab accept",
    scope: "command"
  },
  "command.close": {
    id: "command.close",
    keys: ["Esc"],
    label: "Esc close",
    scope: "command"
  },
  "approval.approve_once": {
    id: "approval.approve_once",
    keys: ["Y"],
    label: "Y approve once",
    scope: "approval"
  },
  "approval.allow_target": {
    id: "approval.allow_target",
    keys: ["S"],
    label: "S allow target",
    scope: "approval"
  },
  "approval.deny": {
    id: "approval.deny",
    keys: ["N"],
    label: "N deny",
    scope: "approval"
  },
  "approval.cancel": {
    id: "approval.cancel",
    keys: ["Esc"],
    label: "Esc cancel",
    scope: "approval"
  },
  "action.select": {
    id: "action.select",
    keys: ["Up", "Down"],
    label: "Up/Down select",
    scope: "action"
  },
  "action.details": {
    id: "action.details",
    keys: ["Enter"],
    label: "Enter details",
    scope: "action"
  },
  "action.page": {
    id: "action.page",
    keys: ["PgUp", "PgDn"],
    label: "PgUp/PgDn",
    scope: "action"
  },
  "run-board.toggle_rail": {
    id: "run-board.toggle_rail",
    keys: ["Ctrl+R"],
    label: "Ctrl+R workers",
    scope: "global"
  }
});

export function shortcutLabel(id: TuiShortcutId): string {
  return TUI_SHORTCUTS[id].label;
}

export function shortcutHint(ids: readonly TuiShortcutId[], separator = " | "): string {
  return ids.map((id) => shortcutLabel(id)).join(separator);
}

export function shortcutPhrase(id: TuiShortcutId, purpose: string): string {
  return `${shortcutLabel(id)} for ${purpose}`;
}

export function detailShortcutPhrase(purpose = "details"): string {
  return shortcutPhrase("detail.open", purpose);
}

export function appendDetailShortcut(value: string, purpose = "details"): string {
  const trimmed = value.trimEnd();
  const suffix = detailShortcutPhrase(purpose);
  if (trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")) {
    return `${trimmed} ${suffix}.`;
  }
  return `${trimmed}. ${suffix}.`;
}

export function detailOpenHint(): string {
  return `${shortcutLabel("detail.open")} opens the latest detail.`;
}

export function transcriptSearchHint(summary: string | undefined): string {
  return `${summary ?? "search"} | ${shortcutHint(["search.jump", "command.close"])}`;
}
