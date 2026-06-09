export function labelForRunBoardAction(command: string): string {
  const raw = command.trim();
  const normalized = raw.toLowerCase();
  if (normalized === "/review" || normalized.startsWith("/review ")) {
    return "Review this workspace";
  }
  switch (normalized) {
    case "/revert last":
      return "Undo latest change";
    case "/diff":
      return "Review changes";
    case "/commit":
      return "Commit when ready";
    case "/output":
      return "Review output";
    case "/continue":
      return "Continue work";
    case "/debug latest":
      return "Review latest issue";
    case "/plan":
      return "Plan a change";
    default:
      return raw.startsWith("/") ? "Next step" : raw || "Next step";
  }
}
