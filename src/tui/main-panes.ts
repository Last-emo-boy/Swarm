export type MainPaneId = "chat" | "log" | "overview" | "output" | "sessions" | "attempts" | "agents" | "blackboard";

export const mainPaneOrder: MainPaneId[] = ["chat", "log", "overview", "output", "sessions", "attempts", "agents", "blackboard"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  log: "Trace",
  overview: "Overview",
  output: "Output",
  sessions: "Sessions",
  attempts: "Attempts",
  agents: "Activity",
  blackboard: "Blackboard"
};

export const mainPaneShortLabels: Record<MainPaneId, string> = {
  chat: "Chat",
  log: "Tr",
  overview: "Ov",
  output: "Out",
  sessions: "Ses",
  attempts: "Att",
  agents: "Act",
  blackboard: "Blk"
};

export function nextMainPane(current: MainPaneId, direction: 1 | -1): MainPaneId {
  const index = mainPaneOrder.indexOf(current);
  const next = (index + direction + mainPaneOrder.length) % mainPaneOrder.length;
  return mainPaneOrder[next] ?? "chat";
}
