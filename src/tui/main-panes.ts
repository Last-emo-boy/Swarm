export type MainPaneId = "overview" | "output" | "sessions" | "attempts" | "agents" | "blackboard";

export const mainPaneOrder: MainPaneId[] = ["overview", "output", "sessions", "attempts", "agents", "blackboard"];

export const mainPaneLabels: Record<MainPaneId, string> = {
  overview: "Overview",
  output: "Output",
  sessions: "Sessions",
  attempts: "Attempts",
  agents: "Agents",
  blackboard: "Blackboard"
};

export function nextMainPane(current: MainPaneId, direction: 1 | -1): MainPaneId {
  const index = mainPaneOrder.indexOf(current);
  const next = (index + direction + mainPaneOrder.length) % mainPaneOrder.length;
  return mainPaneOrder[next] ?? "overview";
}
