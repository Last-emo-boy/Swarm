export function labelForRunBoardAction(command: string): string {
  switch (command.trim().toLowerCase()) {
    case "/revert last":
      return "Undo latest change";
    case "/diff":
      return "Review changes";
    case "/commit":
      return "Commit when ready";
    case "/output":
      return "Open output";
    case "/continue":
      return "Continue work";
    case "/debug latest":
      return "Inspect latest issue";
    case "/review":
      return "Review this workspace";
    case "/plan":
      return "Plan a change";
    default:
      return command;
  }
}
