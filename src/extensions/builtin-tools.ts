import type { CapabilityDescriptor, CapabilityProvider } from "./types.js";

type BuiltinToolDescriptor = {
  name: string;
  action?: string;
  aliases?: string[];
  title: string;
  description: string;
  riskClass: CapabilityDescriptor["riskClass"];
  permissionName: string;
  inputSchema: unknown;
  modelVisible?: boolean;
  userVisible?: boolean;
};

const BUILTIN_TOOLS: BuiltinToolDescriptor[] = [
  {
    name: "Read",
    action: "file.read",
    aliases: ["file.read"],
    title: "Read File",
    description: "Read one or more workspace files subject to read roots and deny rules.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file_path: "absolute or workspace path", path: "compat path", offset: "number", limit: "number", pages: "reserved for PDFs" })
  },
  {
    name: "LS",
    action: "file.list",
    aliases: ["file.list"],
    title: "List Files",
    description: "List files under a workspace directory.",
    riskClass: "r0",
    permissionName: "LS",
    inputSchema: objectSchema({ root: "string", maxFiles: "number", maxDepth: "number" }),
    modelVisible: false,
    userVisible: false
  },
  {
    name: "Glob",
    action: "file.glob",
    aliases: ["file.glob"],
    title: "Glob Files",
    description: "Find files under a directory using a glob pattern.",
    riskClass: "r0",
    permissionName: "Glob",
    inputSchema: objectSchema({ root: "string", pattern: "string", maxResults: "number", maxDepth: "number" })
  },
  {
    name: "Grep",
    action: "file.grep",
    aliases: ["file.grep"],
    title: "Search Files",
    description: "Search text in workspace files with regex support.",
    riskClass: "r0",
    permissionName: "Grep",
    inputSchema: objectSchema({ root: "string", pattern: "string", include: "string", maxMatches: "number", contextLines: "number" })
  },
  {
    name: "file.stat",
    title: "Stat Path",
    description: "Inspect file or directory metadata.",
    riskClass: "r0",
    permissionName: "Stat",
    inputSchema: objectSchema({ path: "string" }),
    modelVisible: false
  },
  {
    name: "Write",
    action: "file.write",
    aliases: ["file.write"],
    title: "Write File",
    description: "Create or replace a workspace file when direct writes and permissions allow it.",
    riskClass: "r1",
    permissionName: "Write",
    inputSchema: objectSchema({ file_path: "absolute or workspace path", path: "compat path", content: "string" })
  },
  {
    name: "Edit",
    action: "file.edit",
    aliases: ["file.edit"],
    title: "Edit File",
    description: "Apply a targeted string replacement or insertion to a workspace file.",
    riskClass: "r1",
    permissionName: "Edit",
    inputSchema: objectSchema({ file_path: "absolute or workspace path", path: "compat path", old_string: "string", new_string: "string", replace_all: "boolean" })
  },
  {
    name: "NotebookEdit",
    action: "notebook.edit",
    aliases: ["notebook.edit"],
    title: "Edit Notebook",
    description: "Edit a Jupyter notebook cell by replacing, inserting, or deleting source.",
    riskClass: "r1",
    permissionName: "Edit",
    inputSchema: objectSchema({ notebook_path: "string", cell_id: "string", new_source: "string", cell_type: "code | markdown", edit_mode: "replace | insert | delete" })
  },
  {
    name: "TodoWrite",
    action: "todo.write",
    aliases: ["todo.write"],
    title: "Write Todo State",
    description: "Update the current agent todo list.",
    riskClass: "r0",
    permissionName: "TodoWrite",
    inputSchema: objectSchema({ todos: "array of {content,status}" })
  },
  {
    name: "BlackboardWrite",
    action: "blackboard.write",
    aliases: ["blackboard.write"],
    title: "Write Blackboard",
    description: "Write a typed shared blackboard entry for other Swarm agents through the runtime protocol.",
    riskClass: "r0",
    permissionName: "BlackboardWrite",
    inputSchema: objectSchema({ key: "string", type: "plan | observation | evidence | result | critique | decision | artifact", value: "JSON value", visibility: "private | team | public", tags: "string[]" })
  },
  {
    name: "BlackboardSearch",
    action: "blackboard.search",
    aliases: ["blackboard.search"],
    title: "Search Blackboard",
    description: "Search shared blackboard entries by text and metadata filters.",
    riskClass: "r0",
    permissionName: "BlackboardRead",
    inputSchema: objectSchema({ query: "string", type: "entry type", tag: "string", key_prefix: "string", task_id: "string", agent_id: "string", limit: "number" })
  },
  {
    name: "BlackboardRead",
    action: "blackboard.read",
    aliases: ["blackboard.read"],
    title: "Read Blackboard",
    description: "Read a shared blackboard entry by entry_id or key.",
    riskClass: "r0",
    permissionName: "BlackboardRead",
    inputSchema: objectSchema({ entry_id: "string", key: "string", limit: "number" })
  },
  {
    name: "BlackboardList",
    action: "blackboard.list",
    aliases: ["blackboard.list"],
    title: "List Blackboard",
    description: "List recent shared blackboard entries with optional metadata filters.",
    riskClass: "r0",
    permissionName: "BlackboardRead",
    inputSchema: objectSchema({ type: "entry type", tag: "string", key_prefix: "string", task_id: "string", agent_id: "string", limit: "number" })
  },
  {
    name: "Bash",
    action: "shell.exec",
    aliases: ["shell.exec"],
    title: "Run Shell",
    description: "Run a local shell command in the workspace with approval when required. Use run_in_background for dev servers, watchers, and other persistent commands.",
    riskClass: "r2",
    permissionName: "Bash",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number", maxOutputBytes: "number", run_in_background: "boolean", description: "short label", maxLogBytes: "number" })
  },
  {
    name: "ProcessStart",
    action: "process.start",
    aliases: ["process.start"],
    title: "Start Background Process",
    description: "Start a persistent local command such as a backend, dev server, or watcher. Returns a process id and log path immediately.",
    riskClass: "r2",
    permissionName: "Bash",
    inputSchema: objectSchema({ command: "string", cwd: "string", description: "short label", timeoutMs: "optional maximum lifetime in ms", maxLogBytes: "optional log cap in bytes" })
  },
  {
    name: "ProcessStatus",
    action: "process.status",
    aliases: ["process.status"],
    title: "Background Process Status",
    description: "Inspect one background process by id, or list recent session processes when no id is supplied.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ processId: "process id", sessionId: "optional session id" })
  },
  {
    name: "ProcessList",
    action: "process.list",
    aliases: ["process.list"],
    title: "List Background Processes",
    description: "List known background processes with status, command, pid, and log path.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ sessionId: "optional session id", status: "running | completed | failed | stopped | unknown", limit: "number" })
  },
  {
    name: "ProcessTail",
    action: "process.tail",
    aliases: ["process.tail"],
    title: "Tail Background Process Log",
    description: "Read recent output from a background process log without loading the whole file.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ processId: "process id", sessionId: "optional session id", lines: "line count", maxBytes: "byte cap" })
  },
  {
    name: "ProcessGrep",
    action: "process.grep",
    aliases: ["process.grep"],
    title: "Search Background Process Log",
    description: "Search a background process log for text or regex matches.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ processId: "process id", sessionId: "optional session id", pattern: "regex or literal text", maxMatches: "number", contextLines: "number" })
  },
  {
    name: "ProcessStop",
    action: "process.stop",
    aliases: ["process.stop", "TaskStop", "KillShell"],
    title: "Stop Background Process",
    description: "Stop a running background process by id.",
    riskClass: "r2",
    permissionName: "Bash",
    inputSchema: objectSchema({ processId: "process id", sessionId: "optional session id" })
  },
  {
    name: "exec",
    action: "exec",
    title: "Run Command",
    description: "Run a local command selected by the model with approval when required.",
    riskClass: "r2",
    permissionName: "Exec",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number", maxOutputBytes: "number" }),
    modelVisible: false
  },
  {
    name: "WebSearch",
    action: "web.search",
    aliases: ["web.search"],
    title: "Search Web",
    description: "Search the web through the configured provider or search path.",
    riskClass: "r0",
    permissionName: "WebSearch",
    inputSchema: objectSchema({ query: "string", allowed_domains: "string[]", blocked_domains: "string[]", maxUses: "number" })
  },
  {
    name: "WebFetch",
    action: "web.fetch",
    aliases: ["web.fetch"],
    title: "Fetch Web Page",
    description: "Fetch HTTP(S) content subject to web tool settings and permissions.",
    riskClass: "r2",
    permissionName: "WebFetch",
    inputSchema: objectSchema({ url: "string", prompt: "string", timeoutMs: "number", maxBytes: "number" })
  },
  {
    name: "code.test",
    title: "Run Test Command",
    description: "Run a project test command and capture output.",
    riskClass: "r1",
    permissionName: "CodeTest",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number" }),
    modelVisible: false
  },
  {
    name: "code.lint",
    title: "Run Lint",
    description: "Run a lint-oriented local command for a root or include pattern.",
    riskClass: "r1",
    permissionName: "CodeLint",
    inputSchema: objectSchema({ root: "string", include: "string" }),
    modelVisible: false
  },
  {
    name: "git.status",
    title: "Git Status",
    description: "Inspect the current git status.",
    riskClass: "r0",
    permissionName: "GitStatus",
    inputSchema: objectSchema({ cwd: "string" }),
    modelVisible: false
  },
  {
    name: "git.diff",
    title: "Git Diff",
    description: "Inspect unstaged or staged git diffs.",
    riskClass: "r0",
    permissionName: "GitDiff",
    inputSchema: objectSchema({ cwd: "string", staged: "boolean" }),
    modelVisible: false
  },
  {
    name: "git.log",
    title: "Git Log",
    description: "Inspect recent git commits.",
    riskClass: "r0",
    permissionName: "GitLog",
    inputSchema: objectSchema({ cwd: "string", maxCommits: "number" }),
    modelVisible: false
  },
  {
    name: "git.branch",
    title: "Git Branch",
    description: "List, create, or switch git branches.",
    riskClass: "r2",
    permissionName: "GitBranch",
    inputSchema: objectSchema({ cwd: "string", action: "list | create | switch", name: "string" }),
    modelVisible: false
  },
  {
    name: "package.install",
    title: "Install Packages",
    description: "Run a package manager install command.",
    riskClass: "r2",
    permissionName: "PackageInstall",
    inputSchema: objectSchema({ command: "string", cwd: "string", timeoutMs: "number" }),
    modelVisible: false
  },
  {
    name: "Agent",
    action: "agent.delegate",
    aliases: ["Task", "agent.delegate"],
    title: "Delegate Agent Task",
    description: "Delegate a bounded task to an internal specialist agent.",
    riskClass: "r1",
    permissionName: "Agent",
    inputSchema: objectSchema({ description: "short task description", prompt: "task prompt", subagent_type: "optional agent type", model: "optional model", run_in_background: "boolean", capability: "compat capability", task: "compat task", file_scope: "string[]" })
  }
];

export class BuiltinLocalToolProvider implements CapabilityProvider {
  readonly id = "local-tools";
  readonly title = "Built-in local tools";

  listCapabilities(): CapabilityDescriptor[] {
    return BUILTIN_TOOLS.map((tool) => ({
      id: `local_tool.${tool.name}`,
      kind: "local_tool",
      source: "builtin",
      trust: "builtin",
      providerId: this.id,
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskClass: tool.riskClass,
      permissionName: tool.permissionName,
      modelVisible: tool.modelVisible ?? true,
      userVisible: tool.userVisible ?? true,
      status: "available",
      metadata: {
        action: tool.action ?? tool.name,
        aliases: tool.aliases
      }
    }));
  }
}

function objectSchema(properties: Record<string, string>): unknown {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [
        name,
        { description }
      ])
    )
  };
}
