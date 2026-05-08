export type MainPaneId = "overview" | "output" | "sessions" | "attempts" | "agents" | "blackboard";

export const mainPaneOrder: MainPaneId[] = ["overview", "output", "sessions", "attempts", "agents", "blackboard"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  overview: "Overview",
  output: "Output",
  sessions: "Sessions",
  attempts: "Attempts",
  agents: "Activity",
  blackboard: "Blackboard"
};

export function nextMainPane(current: MainPaneId, direction: 1 | -1): MainPaneId {
  const index = mainPaneOrder.indexOf(current);
  const next = (index + direction + mainPaneOrder.length) % mainPaneOrder.length;
  return mainPaneOrder[next] ?? "overview";
}

export function mainPaneShortcutDirection(character: string | undefined, key: { ctrl?: boolean }): 1 | -1 | undefined {
  if (!key.ctrl && character !== "\x0e" && character !== "\x10") {
    return undefined;
  }
  const normalized = normalizeCtrlCharacter(character);
  if (normalized === "n") {
    return 1;
  }
  if (normalized === "p") {
    return -1;
  }
  return undefined;
}

function normalizeCtrlCharacter(character: string | undefined): string {
  if (!character) {
    return "";
  }
  if (character === "\x0e") {
    return "n";
  }
  if (character === "\x10") {
    return "p";
  }
  return character.toLowerCase();
}
