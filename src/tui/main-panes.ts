export type MainPaneId = "chat" | "plan" | "board" | "sessions" | "workers" | "activity" | "output" | "skills" | "automations" | "trace";

export const allMainPaneIds: MainPaneId[] = ["chat", "plan", "board", "sessions", "workers", "activity", "output", "skills", "automations", "trace"];

export const mainPaneOrder: MainPaneId[] = ["chat", "plan", "board", "trace"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  plan: "Result",
  board: "Details",
  sessions: "Tasks",
  workers: "Team",
  activity: "Activity",
  output: "Output",
  skills: "Skills",
  automations: "Automations",
  trace: "Logs"
};

export const mainPaneShortLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  plan: "Res",
  board: "Det",
  sessions: "Task",
  workers: "Team",
  activity: "Act",
  output: "Out",
  skills: "Skl",
  automations: "Auto",
  trace: "Log"
};

const mainPaneAliases: Record<string, MainPaneId> = {
  agents: "workers",
  attempts: "trace",
  automation: "automations",
  blackboard: "board",
  debug: "trace",
  detail: "board",
  details: "board",
  inspect: "board",
  observatory: "board",
  overview: "board",
  report: "plan",
  result: "plan",
  run: "plan",
  runs: "plan",
  task: "sessions",
  tasks: "sessions",
  log: "trace",
  logs: "trace",
  symphony: "automations"
};

export function normalizeMainPaneId(value: string | undefined): MainPaneId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const direct = allMainPaneIds.find((pane) => pane === normalized);
  return direct ?? mainPaneAliases[normalized];
}

export function nextMainPane(current: MainPaneId, direction: 1 | -1): MainPaneId {
  const index = mainPaneOrder.indexOf(current);
  if (index < 0) {
    return direction > 0 ? mainPaneOrder[0] ?? "chat" : mainPaneOrder[mainPaneOrder.length - 1] ?? "trace";
  }
  const next = (index + direction + mainPaneOrder.length) % mainPaneOrder.length;
  return mainPaneOrder[next] ?? "chat";
}
