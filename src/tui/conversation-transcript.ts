import type { RuntimeAgentIdentity, RuntimeEvent } from "../runtime/events.js";
import type { ToolAction } from "../tools/types.js";
import type { ConversationMessage, TranscriptTool } from "./conversation-layout.js";

/**
 * The conversation transcript as runtime events change it. Each tool call is one row, added when it starts and updated
 * in place as it waits for approval and returns; a subagent is one row from start to finish. Thinking and step
 * notices are not kept: the activity line shows what runs now, and the answer's footer says how the run ended.
 */

export function slashCommandTranscriptMessage(commandLine: string): ConversationMessage {
  return {
    role: "user",
    kind: "command",
    brief: commandLine,
    title: "Command"
  };
}

export function slashToolUseTranscriptMessage(action: ToolAction): ConversationMessage {
  const tool = toolForAction(action.type, describeToolTarget(action));
  return {
    role: "system",
    kind: "tool_use",
    status: "running",
    tool: { ...tool, startedAt: Date.now() },
    brief: `${tool.verb} ${tool.target}`.trim(),
    detail: renderToolActionDetail(action),
    title: "Tool use"
  };
}

/** The transcript after `event`: the same array when the event changes nothing that is shown. */
export function applyRuntimeEventToTranscript(messages: ConversationMessage[], event: RuntimeEvent): ConversationMessage[] {
  if (event.type === "loop_activity") {
    if (event.phase !== "running_tool" && event.phase !== "waiting_approval") {
      return messages;
    }
    const id = event.task_id ? toolRowId(event.task_id) : undefined;
    const existing = id ? findRow(messages, id) : undefined;
    if (event.phase === "waiting_approval") {
      return existing !== undefined ? updateRow(messages, existing, (row) => withTool(row, { approval: "pending" }, "pending")) : messages;
    }
    if (existing !== undefined) {
      return messages;
    }
    const action = event.tool ?? "";
    const tool = toolForAction(action, activityTarget(event.message, action));
    return [...messages, {
      role: "system",
      kind: "tool_use",
      status: "running",
      ...(id ? { id } : {}),
      tool: { ...tool, startedAt: Date.now() },
      brief: withAgentPrefix(event.agent, `${tool.verb} ${tool.target}`.trim()),
      title: event.agent ? "Agent tool use" : "Tool use"
    }];
  }

  if (event.type === "approval") {
    const id = event.request.task_id ? toolRowId(event.request.task_id) : undefined;
    const existing = id ? findRow(messages, id) : undefined;
    const approval = event.status;
    if (existing !== undefined) {
      return updateRow(messages, existing, (row) => withTool(row, { approval }, approval === "denied" ? "error" : approval === "pending" ? "pending" : "running"));
    }
    const tool = toolForAction(String(event.request.action), event.request.target);
    return [...messages, {
      role: "system",
      kind: "tool_use",
      status: approval === "denied" ? "error" : approval === "pending" ? "pending" : "running",
      ...(id ? { id } : {}),
      tool: { ...tool, approval, startedAt: Date.now() },
      brief: `${tool.verb} ${tool.target}`.trim(),
      detail: event.request.detail,
      title: "Tool use"
    }];
  }

  if (event.type === "tool_result") {
    const status: ConversationMessage["status"] = event.status === "failed" ? "error" : event.status === "partial" ? "warning" : "success";
    const note = status === "success" ? undefined : firstLine(event.summary);
    const id = toolRowId(event.task_id);
    const existing = findRow(messages, id);
    const detail = toolResultDetail(event);
    if (existing !== undefined) {
      return updateRow(messages, existing, (row) => ({
        ...withTool(row, { ...(note ? { note } : {}), ms: row.tool?.startedAt ? Date.now() - row.tool.startedAt : undefined }, status),
        detail,
        preview: toolResultPreview(event)
      }));
    }
    const tool = toolForAction(event.action, firstLine(event.title) || firstLine(event.summary));
    return [...messages, {
      role: "system",
      kind: "tool_use",
      status,
      id,
      tool: { ...tool, ...(note ? { note } : {}) },
      brief: withAgentPrefix(event.agent, `${tool.verb} ${tool.target}`.trim()),
      detail,
      preview: toolResultPreview(event),
      title: event.agent ? "Agent tool result" : "Tool result"
    }];
  }

  if (event.type === "agent_run_started") {
    const id = agentRowId(event.worker.worker_id);
    if (findRow(messages, id) !== undefined) {
      return messages;
    }
    const label = workerLabel(event.worker);
    return [...messages, {
      role: "system",
      kind: "tool_use",
      status: "running",
      id,
      tool: { verb: "Agent", target: `${label}: ${firstLine(event.task_packet.objective)}`, startedAt: Date.now() },
      brief: `Agent ${label}: ${firstLine(event.task_packet.objective)}`,
      detail: event.task_packet.objective,
      title: "Agent started"
    }];
  }

  if (event.type === "agent_run_completed") {
    const id = agentRowId(event.worker.worker_id);
    const status: ConversationMessage["status"] = event.worker.status === "failed" ? "error" : event.worker.status === "stopped" ? "warning" : "success";
    const label = workerLabel(event.worker);
    const note = status === "success" ? undefined : firstLine(event.result) || event.worker.status;
    const existing = findRow(messages, id);
    const completed = (row: ConversationMessage): ConversationMessage => ({
      ...withTool(row, { ...(note ? { note } : {}), ms: row.tool?.startedAt ? Date.now() - row.tool.startedAt : undefined }, status),
      detail: event.result,
      preview: agentResultPreview(label, event.result),
      title: "Agent completed"
    });
    if (existing !== undefined) {
      return updateRow(messages, existing, completed);
    }
    return [...messages, completed({
      role: "system",
      kind: "tool_use",
      status,
      id,
      tool: { verb: "Agent", target: `${label}: ${firstLine(event.worker.objective)}` },
      brief: `Agent ${label}: ${firstLine(event.worker.objective)}`
    })];
  }

  return messages;
}

export function appendTranscriptMessage(
  messages: ConversationMessage[],
  message: ConversationMessage
): ConversationMessage[] {
  const last = messages.at(-1);
  if (last && transcriptMessageSignature(last) === transcriptMessageSignature(message)) {
    return messages;
  }
  return [...messages, message];
}

export function transcriptMessageSignature(message: ConversationMessage): string {
  return [
    message.role,
    message.kind ?? "message",
    message.status ?? "",
    message.brief
  ].join("|");
}

/** What a tool call does, in the words the transcript shows: a verb such as Read or Bash, and the kind of work it counts as. */
export type ToolKind = "read" | "edit" | "run" | "search" | "fetch" | "git" | "agent" | "other";

const VERBS: Record<string, { verb: string; kind: ToolKind }> = {
  "file.read": { verb: "Read", kind: "read" },
  "json.read": { verb: "Read", kind: "read" },
  "file.stat": { verb: "Read", kind: "read" },
  "file.resolve": { verb: "Read", kind: "read" },
  "file.list": { verb: "List", kind: "search" },
  "file.glob": { verb: "Find", kind: "search" },
  "file.grep": { verb: "Search", kind: "search" },
  "file.write": { verb: "Write", kind: "edit" },
  "file.edit": { verb: "Edit", kind: "edit" },
  "file.patch": { verb: "Edit", kind: "edit" },
  "json.edit": { verb: "Edit", kind: "edit" },
  "notebook.edit": { verb: "Edit", kind: "edit" },
  "file.mkdir": { verb: "Create", kind: "edit" },
  "file.move": { verb: "Move", kind: "edit" },
  "file.copy": { verb: "Copy", kind: "edit" },
  "file.delete": { verb: "Delete", kind: "edit" },
  "shell.exec": { verb: "Bash", kind: "run" },
  exec: { verb: "Bash", kind: "run" },
  "process.start": { verb: "Bash", kind: "run" },
  "code.test": { verb: "Test", kind: "run" },
  "code.lint": { verb: "Lint", kind: "run" },
  "code.build": { verb: "Build", kind: "run" },
  "package.install": { verb: "Install", kind: "run" },
  "web.search": { verb: "Search", kind: "fetch" },
  "web.fetch": { verb: "Fetch", kind: "fetch" },
  "agent.delegate": { verb: "Agent", kind: "agent" },
  // The names capability calls report their results under.
  Read: { verb: "Read", kind: "read" },
  Write: { verb: "Write", kind: "edit" },
  Edit: { verb: "Edit", kind: "edit" },
  Bash: { verb: "Bash", kind: "run" },
  Grep: { verb: "Search", kind: "search" },
  Glob: { verb: "Find", kind: "search" },
  WebFetch: { verb: "Fetch", kind: "fetch" },
  WebSearch: { verb: "Search", kind: "fetch" }
};

export function toolKind(verbOrAction: string): ToolKind {
  if (verbOrAction === "Agent") {
    return "agent";
  }
  const found = VERBS[verbOrAction] ?? Object.values(VERBS).find((entry) => entry.verb === verbOrAction);
  if (found) {
    return found.kind;
  }
  return verbOrAction === "Git" ? "git" : "other";
}

function toolForAction(action: string, target: string): TranscriptTool {
  const known = VERBS[action];
  if (known) {
    return { verb: known.verb, target: oneLine(target) };
  }
  if (action.startsWith("git.")) {
    return { verb: "Git", target: oneLine([action.slice(4), target].filter(Boolean).join(" ")) };
  }
  if (action.startsWith("process.")) {
    return { verb: "Process", target: oneLine([action.slice(8), target].filter(Boolean).join(" ")) };
  }
  if (action.startsWith("blackboard.") || action === "todo.write") {
    return { verb: "Note", target: oneLine(target) };
  }
  // A capability or deferred tool: its own name is the verb.
  return { verb: action ? action.split(".").at(-1)!.replace(/^./, (first) => first.toUpperCase()) : "Step", target: oneLine(target) };
}

/** The target of a running tool from the loop's activity text, `Running <action> <target>`. */
function activityTarget(message: string, action: string): string {
  const text = message.replace(/^#\d+\s+/, "").replace(/^Running\s+/, "").trim();
  return action && text.startsWith(`${action} `) ? text.slice(action.length + 1) : text === action ? "" : text;
}

/**
 * The line a turn's settled tool calls fold into, such as "Read 2 files, ran 1 command · 1 failed". `failed` and
 * `denied` count the calls that did not succeed.
 */
export function toolGroupSummary(rows: ReadonlyArray<Pick<ConversationMessage, "status" | "tool">>): { text: string; failed: number; denied: number } {
  const counts = new Map<ToolKind, number>();
  let failed = 0;
  let denied = 0;
  for (const row of rows) {
    const kind = toolKind(row.tool?.verb ?? "");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (row.tool?.approval === "denied") {
      denied += 1;
    } else if (row.status === "error") {
      failed += 1;
    }
  }
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const parts = ([
    ["read", (n: number) => `read ${plural(n, "file", "files")}`],
    ["edit", (n: number) => `edited ${plural(n, "file", "files")}`],
    ["run", (n: number) => `ran ${plural(n, "command", "commands")}`],
    ["search", (n: number) => `searched ${n === 1 ? "once" : `${n} times`}`],
    ["fetch", (n: number) => `fetched ${plural(n, "page", "pages")}`],
    ["git", (n: number) => plural(n, "git step", "git steps")],
    ["agent", (n: number) => plural(n, "agent", "agents")],
    ["other", (n: number) => plural(n, "other step", "other steps")]
  ] as const).flatMap(([kind, phrase]) => counts.get(kind) ? [phrase(counts.get(kind)!)] : []);
  const text = parts.join(", ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, denied };
}

const toolRowId = (taskId: string): string => `tool:${taskId}`;
const agentRowId = (workerId: string): string => `agent:${workerId}`;

function findRow(messages: ConversationMessage[], id: string): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.id === id) {
      return index;
    }
  }
  return undefined;
}

function updateRow(messages: ConversationMessage[], index: number, change: (row: ConversationMessage) => ConversationMessage): ConversationMessage[] {
  const next = messages.slice();
  next[index] = change(messages[index]!);
  return next;
}

function withTool(row: ConversationMessage, change: Partial<TranscriptTool>, status: ConversationMessage["status"]): ConversationMessage {
  const defined = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as Partial<TranscriptTool>;
  return { ...row, status, tool: { ...row.tool ?? { verb: "Step", target: row.brief }, ...defined } };
}

function describeToolTarget(action: ToolAction): string {
  const record = action as Record<string, unknown>;
  for (const field of ["command", "path", "pattern", "url", "query", "task", "root", "notebookPath", "processId", "key"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return Array.isArray(record.paths) ? record.paths.join(", ") : "";
}

function renderToolActionDetail(action: ToolAction): string {
  const lines = [`Action: ${action.type}`];
  if ("command" in action && typeof action.command === "string") {
    lines.push(`Command: ${action.command}`);
  }
  if ("cwd" in action && typeof action.cwd === "string") {
    lines.push(`CWD: ${action.cwd}`);
  }
  if ("path" in action && typeof action.path === "string") {
    lines.push(`Path: ${action.path}`);
  }
  if ("root" in action && typeof action.root === "string") {
    lines.push(`Root: ${action.root}`);
  }
  if ("pattern" in action && typeof action.pattern === "string") {
    lines.push(`Pattern: ${action.pattern}`);
  }
  if ("query" in action && typeof action.query === "string") {
    lines.push(`Query: ${action.query}`);
  }
  return lines.join("\n");
}

function toolResultDetail(event: Extract<RuntimeEvent, { type: "tool_result" }>): string {
  return [`${event.action}: ${event.summary}`, event.content?.trim()].filter(Boolean).join("\n\n");
}

function toolResultPreview(event: Extract<RuntimeEvent, { type: "tool_result" }>): string {
  const summary = `${event.action}: ${event.summary}`;
  const content = event.content?.trim();
  if (!content) {
    return summary;
  }
  const contentLines = content.split(/\r?\n/).filter(Boolean).slice(0, 4);
  return [summary, ...contentLines].join("\n");
}

function withAgentPrefix(agent: RuntimeAgentIdentity | undefined, value: string): string {
  const label = agentIdentityLabel(agent);
  return label ? `${label}: ${value}` : value;
}

function workerLabel(worker: Extract<RuntimeEvent, { type: "agent_run_started" }>["worker"]): string {
  return agentIdentityLabel({
    worker_id: worker.worker_id,
    display_name: worker.display_name,
    role_title: worker.role_title,
    agent_spec_id: worker.agent_spec_id,
    invocation_mode: worker.invocation_mode
  }) ?? worker.worker_id;
}

function agentIdentityLabel(agent: RuntimeAgentIdentity | undefined): string | undefined {
  if (!agent) {
    return undefined;
  }
  const name = agent.display_name?.trim() || agent.agent_id || agent.worker_id || agent.agent_spec_id || agent.capability || agent.role;
  if (!name) {
    return undefined;
  }
  const role = agent.role_title?.trim();
  return role ? `${name} / ${role}` : name;
}

function agentResultPreview(label: string, result: string): string {
  const lines = result.trim().split(/\r?\n/).filter(Boolean).slice(0, 4);
  return [label, ...lines].join("\n");
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text;
}

function firstLine(value: string | undefined): string {
  return value?.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
