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
  | "workers.toggle";

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
    label: "? keys",
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
    keys: ["y"],
    label: "y yes",
    scope: "approval"
  },
  "approval.allow_target": {
    id: "approval.allow_target",
    keys: ["a", "s"],
    label: "a always",
    scope: "approval"
  },
  "approval.deny": {
    id: "approval.deny",
    keys: ["n"],
    label: "n no",
    scope: "approval"
  },
  "approval.cancel": {
    id: "approval.cancel",
    keys: ["Esc"],
    label: "Esc no",
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
  "workers.toggle": {
    id: "workers.toggle",
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

/** Every key the TUI answers to, by where it works: what the keys view (? on an empty prompt) lists. */
export const KEYS_VIEW: ReadonlyArray<{ where: string; keys: ReadonlyArray<readonly [key: string, does: string]> }> = [
  {
    where: "Prompt",
    keys: [
      ["Enter", "send"],
      ["Alt+Enter  Ctrl+J", "new line"],
      ["↑ ↓", "earlier prompts"],
      ["Tab", "complete a command"],
      ["/", "commands"],
      ["?", "these keys, on an empty prompt"],
      ["Esc", "move to the transcript, on an empty prompt"]
    ]
  },
  {
    where: "Transcript",
    keys: [
      ["↑ ↓  j k", "pick a row"],
      ["Enter  x", "fold or unfold it"],
      ["o  Ctrl+O", "open its detail"],
      ["/", "search"],
      ["PgUp PgDn", "scroll"],
      ["Esc, or type", "back to the prompt"]
    ]
  },
  {
    where: "Approval",
    keys: [
      ["y", "yes, this once"],
      ["a", "always: this target, for the rest of the session"],
      ["n  Esc", "no"],
      ["?", "everything the request carries"]
    ]
  },
  {
    where: "Anywhere",
    keys: [
      ["Ctrl+C", "interrupt a run, or quit when idle"],
      ["Ctrl+O", "the latest detail"],
      ["Ctrl+F", "search the transcript"],
      ["Ctrl+R", "running workers, while a run is busy"],
      ["Ctrl+T", "task detail"],
      ["/view <name>", "trace, overview, output, sessions, attempts, agents, blackboard"],
      ["/tickets", "tickets"]
    ]
  },
  {
    where: "Views",
    keys: [
      ["Esc  q", "back to the conversation"],
      ["/", "back, with a command started"]
    ]
  }
];
