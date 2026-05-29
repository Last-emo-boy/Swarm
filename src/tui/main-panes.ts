export type MainPaneId = "chat" | "plan" | "activity" | "output" | "sessions" | "workers" | "trace" | "board";

export const mainPaneOrder: MainPaneId[] = ["chat", "plan", "activity", "output", "sessions", "workers", "trace", "board"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  plan: "Plan",
  activity: "Activity",
  output: "Output",
  sessions: "Sessions",
  workers: "Workers",
  trace: "Trace",
  board: "Board"
};

export const mainPaneShortLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  plan: "Plan",
  activity: "Act",
  output: "Out",
  sessions: "Ses",
  workers: "Wrk",
  trace: "Tr",
  board: "Brd"
};

export const mainPaneAliases: Record<string, MainPaneId> = {
  agents: "activity",
  attempts: "trace",
  blackboard: "board",
  log: "trace",
  overview: "plan"
};

export function normalizeMainPaneId(value: string | undefined): MainPaneId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const direct = mainPaneOrder.find((pane) => pane === normalized);
  return direct ?? mainPaneAliases[normalized];
}

export function nextMainPane(current: MainPaneId, direction: 1 | -1): MainPaneId {
  const index = mainPaneOrder.indexOf(current);
  const next = (index + direction + mainPaneOrder.length) % mainPaneOrder.length;
  return mainPaneOrder[next] ?? "chat";
}
