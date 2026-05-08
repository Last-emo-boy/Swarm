import type { SwarmTask } from "../protocol/types.js";
import { normalizeToolAction } from "../tools/local-tools.js";
import type { ToolAction } from "../tools/types.js";

export class TaskScheduler {
  constructor(private readonly maxParallel: number) {}

  selectReadyTasks(pending: Map<string, SwarmTask>, completed: Set<string>): SwarmTask[] {
    const ready = [...pending.values()]
      .filter((task) => (task.dependencies ?? []).every((dependency) => completed.has(dependency)));
    const mutating = ready.find((task) => !this.isTaskConcurrencySafe(task));
    if (mutating) {
      return [mutating];
    }
    return ready.slice(0, Math.max(1, this.maxParallel));
  }

  isTaskConcurrencySafe(task: SwarmTask): boolean {
    const capability = firstNonEmptyCapability(task.required_capabilities);
    if (!capability) {
      return false;
    }
    let action: ToolAction | undefined;
    try {
      action = tryNormalizeToolAction(task.inputs, capability);
    } catch {
      return false;
    }
    if (!action) {
      return task.type === "analysis" || task.type === "research" || task.type === "planning" || task.type === "review";
    }
    return isReadOnlyToolAction(action);
  }
}

const TOOL_CAPABILITIES = new Set([
  "LS", "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit",
  "TodoWrite", "Bash", "exec", "WebSearch", "WebFetch", "Agent", "Task",
  "BlackboardWrite", "BlackboardSearch", "BlackboardRead", "BlackboardList",
  "tool.file.list", "tool.file.read", "tool.file.glob", "tool.file.grep",
  "tool.file.stat", "tool.file.write", "tool.file.edit", "tool.shell.exec",
  "todo.write",
  "blackboard.write", "blackboard.search", "blackboard.read", "blackboard.list",
  "web.search", "web.fetch",
  "code.test", "code.lint",
  "git.status", "git.diff", "git.log", "git.branch",
  "package.install", "agent.delegate"
]);

function tryNormalizeToolAction(inputs: Record<string, unknown>, capability: string): ToolAction | undefined {
  if (!TOOL_CAPABILITIES.has(capability) && !inputs.action) {
    return undefined;
  }
  return normalizeToolAction(inputs, capability);
}

function isReadOnlyToolAction(action: ToolAction): boolean {
  if (action.type === "git.branch") {
    return !action.action || action.action === "list";
  }
  return [
    "file.list",
    "file.read",
    "file.glob",
    "file.grep",
    "file.stat",
    "web.search",
    "web.fetch",
    "code.test",
    "code.lint",
    "git.status",
    "git.diff",
    "git.log",
    "blackboard.read",
    "blackboard.search",
    "blackboard.list"
  ].includes(action.type);
}

function firstNonEmptyCapability(value: string[]): string | undefined {
  return value.map((item) => item.trim()).find(Boolean);
}
