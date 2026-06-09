import type { RuntimeAgentIdentity, RuntimeEvent } from "../runtime/events.js";
import type { ToolAction } from "../tools/types.js";
import type { ConversationMessage } from "./conversation-layout.js";

export function createStartupLogoMessage(input: {
  version?: string;
  cwd?: string;
  model?: string;
} = {}): ConversationMessage {
  const cwd = input.cwd ?? process.cwd();
  const model = normalizeStartupModel(input.model);
  const metadata = [input.version ? `v${input.version}` : undefined, model].filter((value): value is string => Boolean(value)).join(" · ");
  return {
    role: "system",
    kind: "logo",
    title: input.version,
    detail: metadata || undefined,
    preview: cwd,
    brief: [
      "╭────────────────────────────╮",
      "│            Swarm            │",
      "╰────────────────────────────╯",
      "Local workspace",
      ...(metadata ? [metadata] : []),
      compactPath(cwd)
    ].join("\n")
  };
}

export function slashCommandTranscriptMessage(commandLine: string): ConversationMessage {
  return {
    role: "user",
    kind: "command",
    brief: commandLine,
    title: "Command"
  };
}

export function slashToolUseTranscriptMessage(action: ToolAction): ConversationMessage {
  return {
    role: "system",
    kind: "tool_use",
    status: "running",
    brief: describeToolAction(action),
    detail: renderToolActionDetail(action),
    preview: describeToolAction(action),
    title: "Tool use"
  };
}

export function runtimeEventTranscriptMessage(event: RuntimeEvent): ConversationMessage | undefined {
  if (event.type === "loop_activity") {
    if (event.phase === "thinking") {
      return {
        role: "assistant",
        kind: "thinking",
        status: "running",
        brief: withAgentPrefix(event.agent, collapseThinkingMessage(event.message)),
        title: event.agent ? "Agent thinking" : "Thinking"
      };
    }
    if (event.phase === "running_tool" || event.phase === "running_tools" || event.phase === "waiting_approval") {
      return {
        role: "system",
        kind: event.phase === "waiting_approval" ? "approval" : "tool_use",
        status: "running",
        brief: withAgentPrefix(event.agent, stripActivityPrefix(event.message)),
        title: event.agent
          ? event.phase === "waiting_approval" ? "Agent approval" : "Agent tool use"
          : event.phase === "waiting_approval" ? "Approval" : "Tool use"
      };
    }
    if (event.phase === "failed" || event.phase === "stopped") {
      return {
        role: "system",
        kind: "progress",
        status: event.phase === "failed" ? "error" : "warning",
        brief: withAgentPrefix(event.agent, stripActivityPrefix(event.message)),
        title: event.agent ? "Agent progress" : "Progress"
      };
    }
    return undefined;
  }

  if (event.type === "tool_result") {
    const status = event.status === "failed"
      ? "error"
      : event.status === "partial"
        ? "warning"
        : "success";
    return {
      role: "system",
      kind: "tool_result",
      status,
      brief: withAgentPrefix(event.agent, `${event.action}: ${event.summary}`),
      detail: event.content,
      preview: withAgentPrefix(event.agent, toolResultPreview(event)),
      title: event.agent ? "Agent tool result" : "Tool result"
    };
  }

  if (event.type === "approval") {
    return {
      role: "system",
      kind: "approval",
      status: event.status === "denied" ? "error" : event.status === "approved" ? "success" : "pending",
      brief: `${event.status}: ${event.request.summary}`,
      detail: event.request.detail,
      preview: `${event.status}: ${event.request.summary}`,
      title: "Approval"
    };
  }

  if (event.type === "final" && event.status && event.status !== "completed") {
    return {
      role: "system",
      kind: "progress",
      status: event.status === "failed" ? "error" : "warning",
      brief: `${event.status}: ${firstLine(event.content) || "run ended"}`,
      title: "Final status"
    };
  }

  if (event.type === "agent_run_started") {
    const label = workerLabel(event.worker);
    return {
      role: "system",
      kind: "progress",
      status: "running",
      brief: `${label}: started ${event.task_packet.objective}`,
      title: "Agent started"
    };
  }

  if (event.type === "agent_run_completed") {
    const label = workerLabel(event.worker);
    const status = event.worker.status === "failed"
      ? "error"
      : event.worker.status === "stopped"
        ? "warning"
        : "success";
    return {
      role: "system",
      kind: "progress",
      status,
      brief: `${label}: ${firstLine(event.result) || event.worker.status}`,
      detail: event.result,
      preview: agentResultPreview(label, event.result),
      title: "Agent completed"
    };
  }

  return undefined;
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

function transcriptMessageSignature(message: ConversationMessage): string {
  return [
    message.role,
    message.kind ?? "message",
    message.status ?? "",
    message.brief
  ].join("|");
}

function describeToolAction(action: ToolAction): string {
  switch (action.type) {
    case "file.read":
      return `Read ${previewValue(action.path ?? action.paths?.join(", ") ?? ".")}`;
    case "file.list":
      return `List ${previewValue(action.root)}`;
    case "file.glob":
      return `Glob ${previewValue(action.pattern)} in ${previewValue(action.root)}`;
    case "file.grep":
      return `Grep ${previewValue(action.pattern)} in ${previewValue(action.root)}`;
    case "file.stat":
      return `Stat ${previewValue(action.path)}`;
    case "file.resolve":
      return `Resolve ${previewValue(action.path)}`;
    case "file.write":
      return `Write ${previewValue(action.path)}`;
    case "file.edit":
      return `Edit ${previewValue(action.path)}`;
    case "file.mkdir":
      return `Mkdir ${previewValue(action.path)}`;
    case "file.move":
      return `Move ${previewValue(action.source)} -> ${previewValue(action.destination)}`;
    case "file.copy":
      return `Copy ${previewValue(action.source)} -> ${previewValue(action.destination)}`;
    case "file.delete":
      return `Delete ${previewValue(action.path)}`;
    case "file.patch":
      return `Patch ${previewValue(action.path)}`;
    case "json.read":
      return `Read JSON ${previewValue(action.path)}`;
    case "json.edit":
      return `Edit JSON ${previewValue(action.path)} ${previewValue(action.pointer)}`;
    case "todo.write":
      return `Update TODOs ${action.todos.length} item(s)`;
    case "ask_user_question":
      return `Ask user ${previewValue(action.prompt, 180)}`;
    case "plan.enter":
      return `Enter plan mode ${previewValue(action.objective ?? "planning mode", 180)}`;
    case "plan.exit":
      return `Request plan approval ${previewValue(action.summary ?? "approval requested", 180)}`;
    case "blackboard.write":
      return `Save shared fact ${previewValue(action.key)}`;
    case "blackboard.read":
      return `Read shared fact ${previewValue(action.entryId ?? action.key ?? "entry")}`;
    case "blackboard.search":
      return `Search shared facts ${previewValue(action.query ?? action.keyPrefix ?? action.tag ?? "entries")}`;
    case "blackboard.list":
      return `List shared facts ${previewValue(action.keyPrefix ?? action.tag ?? "entries")}`;
    case "shell.exec":
      return `Run shell command: ${previewValue(action.command, 180)}`;
    case "exec":
      return `Run exec command: ${previewValue(action.command, 180)}`;
    case "process.start":
      return `Start process: ${previewValue(action.command, 180)}`;
    case "process.status":
      return `Process status ${previewValue(action.processId ?? "recent")}`;
    case "process.list":
      return `List processes ${previewValue(action.status ?? action.sessionId ?? "recent")}`;
    case "process.tail":
      return `Tail process ${previewValue(action.processId)}`;
    case "process.grep":
      return `Grep process ${previewValue(action.pattern)} in ${previewValue(action.processId)}`;
    case "process.stop":
      return `Stop process ${previewValue(action.processId)}`;
    case "web.search":
      return `Search web: ${previewValue(action.query, 180)}`;
    case "web.fetch":
      return `Fetch web: ${previewValue(action.url, 180)}`;
    case "notebook.edit":
      return `Edit notebook ${previewValue(action.notebookPath)}`;
    case "code.test":
      return `Run test command: ${previewValue(action.command, 180)}`;
    case "code.lint":
      return `Run lint ${previewValue(action.root ?? action.include ?? ".")}`;
    case "code.build":
      return `Run build command: ${previewValue(action.command, 180)}`;
    case "git.status":
      return `Git status ${previewValue(action.cwd ?? ".")}`;
    case "git.diff":
      return `Git diff ${action.staged ? "--staged" : ""} ${previewValue(action.cwd ?? ".")}`.trim();
    case "git.log":
      return `Git log ${previewValue(action.cwd ?? ".")}`;
    case "git.branch":
      return `Git branch ${previewValue(action.action ?? "list")} ${previewValue(action.name ?? action.cwd ?? ".")}`;
    case "git.show":
      return `Git show ${previewValue(action.revision ?? "HEAD")}${action.path ? ` ${previewValue(action.path)}` : ""}`;
    case "package.install":
      return `Install packages: ${previewValue(action.command, 180)}`;
    case "package.info":
      return `Package info ${previewValue(action.manifest ?? action.cwd ?? ".")}`;
    case "project.detect":
      return `Detect project ${previewValue(action.root ?? ".")}`;
    case "agent.delegate":
      return `Delegate agent task: ${previewValue(action.task, 180)}`;
    default:
      return `Run ${(action as ToolAction).type}`;
  }
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
  if (action.type === "ask_user_question") {
    lines.push(`Question: ${action.prompt}`);
    if (action.reason) {
      lines.push(`Reason: ${action.reason}`);
    }
  }
  if (action.type === "plan.enter" && action.objective) {
    lines.push(`Objective: ${action.objective}`);
  }
  if (action.type === "plan.exit") {
    if (action.summary) {
      lines.push(`Summary: ${action.summary}`);
    }
    lines.push(`Plan: ${action.plan}`);
  }
  return lines.join("\n");
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

function stripActivityPrefix(value: string): string {
  return value.replace(/^#\d+\s+/, "").trim();
}

function collapseThinkingMessage(value: string): string {
  const message = stripActivityPrefix(value);
  return message.includes("thinking") ? message : `Thinking: ${message}`;
}

function previewValue(value: unknown, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim() || "(none)";
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : text;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function normalizeStartupModel(value: string | undefined): string | undefined {
  const model = value?.trim();
  return model && model.toLowerCase() !== "model not configured" ? model : undefined;
}

function compactPath(value: string): string {
  if (value.length <= 80) {
    return value;
  }
  return `...${value.slice(-77)}`;
}
