export type MainPaneId = "board" | "sessions" | "workers" | "activity" | "output" | "skills" | "automations" | "trace" | "chat" | "plan";

export const mainPaneOrder: MainPaneId[] = ["board", "sessions", "workers", "activity", "output", "skills", "automations", "trace", "chat", "plan"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  board: "Board",
  sessions: "Tasks",
  workers: "Workers",
  activity: "Activity",
  output: "Output",
  skills: "Skills",
  automations: "Automations",
  trace: "Trace",
  chat: "Chat",
  plan: "Run"
};

export const mainPaneShortLabels: Record<MainPaneId, string> = {
  board: "Brd",
  sessions: "Task",
  workers: "Wrk",
  activity: "Act",
  output: "Out",
  skills: "Skl",
  automations: "Auto",
  trace: "Tr",
  chat: "Chat",
  plan: "Run"
};

export const mainPaneAliases: Record<string, MainPaneId> = {
  agents: "workers",
  attempts: "trace",
  automation: "automations",
  blackboard: "board",
  run: "plan",
  runs: "plan",
  task: "sessions",
  tasks: "sessions",
  log: "trace",
  overview: "board",
  symphony: "automations"
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
  return mainPaneOrder[next] ?? "board";
}
