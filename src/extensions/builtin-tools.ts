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
  alwaysLoad?: boolean;
  shouldDefer?: boolean;
  readOnly?: boolean;
  concurrencyClass?: CapabilityDescriptor["concurrencyClass"];
  maxResultBytes?: number;
  searchHint?: string;
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
    name: "file.delete",
    action: "file.delete",
    aliases: ["Delete", "delete_file"],
    title: "Delete File",
    description: "Delete a workspace file, or a directory only when recursive=true, subject to workspace write policy.",
    riskClass: "r2",
    permissionName: "Delete",
    inputSchema: objectSchema({ path: "workspace path", recursive: "boolean" })
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
    title: "Save Shared Fact",
    description: "Save a typed shared fact for the team.",
    riskClass: "r0",
    permissionName: "BlackboardWrite",
    inputSchema: objectSchema({ key: "string", type: "plan | observation | evidence | result | critique | decision | artifact", value: "JSON value", visibility: "private | team | public", tags: "string[]" })
  },
  {
    name: "BlackboardSearch",
    action: "blackboard.search",
    aliases: ["blackboard.search"],
    title: "Search Shared Facts",
    description: "Search shared facts by text and filters.",
    riskClass: "r0",
    permissionName: "BlackboardRead",
    inputSchema: objectSchema({ query: "string", type: "entry type", tag: "string", key_prefix: "string", task_id: "string", agent_id: "string", limit: "number" })
  },
  {
    name: "BlackboardRead",
    action: "blackboard.read",
    aliases: ["blackboard.read"],
    title: "Read Shared Fact",
    description: "Read a shared fact by id or key.",
    riskClass: "r0",
    permissionName: "BlackboardRead",
    inputSchema: objectSchema({ entry_id: "string", key: "string", limit: "number" })
  },
  {
    name: "BlackboardList",
    action: "blackboard.list",
    aliases: ["blackboard.list"],
    title: "List Shared Facts",
    description: "List recent shared facts with optional filters.",
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
    name: "Config",
    action: "config.get",
    aliases: ["config.get", "config.set"],
    title: "Safe Config",
    description: "Read or update explicit safe Swarm settings without exposing provider credentials, API keys, headers, tokens, or env secrets.",
    riskClass: "r1",
    permissionName: "ConfigSet",
    inputSchema: objectSchema({ setting: "safe setting key", value: "optional string | number | boolean | null" }),
    shouldDefer: true
  },
  {
    name: "McpResources",
    action: "mcp.resources",
    aliases: ["mcp.resources"],
    title: "List MCP Resources",
    description: "List resources exposed by configured MCP servers with recovery hints for disconnected or auth-required servers.",
    riskClass: "r0",
    permissionName: "McpRead",
    inputSchema: objectSchema({ server: "optional MCP server id", limit: "number" }),
    shouldDefer: true,
    readOnly: true,
    concurrencyClass: "read_parallel"
  },
  {
    name: "McpRead",
    action: "mcp.read",
    aliases: ["mcp.read"],
    title: "Read MCP Resource",
    description: "Read an exact MCP resource URI with truncation and artifact metadata.",
    riskClass: "r0",
    permissionName: "McpRead",
    inputSchema: objectSchema({ server: "MCP server id", uri: "resource URI", maxBytes: "number" }),
    shouldDefer: true,
    readOnly: true,
    concurrencyClass: "read_parallel"
  },
  {
    name: "McpAuth",
    action: "mcp.auth",
    aliases: ["mcp.auth"],
    title: "MCP Auth Status",
    description: "Inspect configured MCP server connection/auth state and recovery without exposing credentials.",
    riskClass: "r0",
    permissionName: "McpRead",
    inputSchema: objectSchema({ server: "optional MCP server id" }),
    shouldDefer: true,
    readOnly: true,
    concurrencyClass: "read_parallel"
  },
  {
    name: "McpCall",
    action: "mcp.call",
    aliases: ["mcp.call"],
    title: "Call MCP Tool",
    description: "Call a configured MCP tool through the capability broker with permission checks and output limits.",
    riskClass: "r2",
    permissionName: "McpCall",
    inputSchema: objectSchema({ server: "optional MCP server id", tool: "MCP tool name", capabilityId: "optional exact capability id", args: "JSON object", maxBytes: "number" }),
    shouldDefer: true,
    concurrencyClass: "network_limited"
  },
  {
    name: "SkillInvoke",
    action: "skill.invoke",
    aliases: ["skill.invoke"],
    title: "Invoke Skill",
    description: "Activate one trusted Agent Skill and write durable context through Swarm's existing skill runtime.",
    riskClass: "r1",
    permissionName: "SkillInvoke",
    inputSchema: objectSchema({ name: "trusted skill name", reason: "optional activation reason" }),
    shouldDefer: true,
    concurrencyClass: "network_limited"
  },
  {
    name: "lsp_diagnostics",
    action: "lsp.diagnostics",
    aliases: ["lsp.diagnostics", "LspDiagnostics"],
    title: "LSP Diagnostics",
    description: "Return low-noise semantic diagnostics for a workspace or file.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "optional workspace file path", root: "optional workspace root", maxResults: "number", contextLines: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_hover",
    action: "lsp.hover",
    aliases: ["lsp.hover", "LspHover"],
    title: "LSP Hover",
    description: "Return type/signature hover information at a workspace file position.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_definition",
    action: "lsp.definition",
    aliases: ["lsp.definition", "LspDefinition"],
    title: "LSP Definition",
    description: "Resolve definition locations with compact snippets at a workspace file position.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", maxResults: "number", contextLines: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_references",
    action: "lsp.references",
    aliases: ["lsp.references", "LspReferences"],
    title: "LSP References",
    description: "Resolve references grouped by file with compact snippets.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", maxResults: "number", contextLines: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_document_symbols",
    action: "lsp.document_symbols",
    aliases: ["lsp.document_symbols", "LspDocumentSymbols"],
    title: "LSP Document Symbols",
    description: "List compact document symbols for a workspace file.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", maxResults: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_workspace_symbols",
    action: "lsp.workspace_symbols",
    aliases: ["lsp.workspace_symbols", "LspWorkspaceSymbols"],
    title: "LSP Workspace Symbols",
    description: "Search workspace symbols with fuzzy scoring and deduplication.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ query: "symbol query", root: "optional workspace root", maxResults: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_completion",
    action: "lsp.completion",
    aliases: ["lsp.completion", "LspCompletion"],
    title: "LSP Completion",
    description: "Return compact completion items at a workspace file position.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", prefix: "string", maxResults: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_code_actions",
    action: "lsp.code_actions",
    aliases: ["lsp.code_actions", "LspCodeActions"],
    title: "LSP Code Actions",
    description: "Return code action previews for a file range without applying edits.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", range: "{start,end}", maxResults: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_rename_preview",
    action: "lsp.rename_preview",
    aliases: ["lsp.rename_preview", "LspRenamePreview"],
    title: "LSP Rename Preview",
    description: "Preview rename locations at a file position without applying edits.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", line: "1-based line", column: "1-based column", newName: "new symbol name", maxResults: "number", contextLines: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "lsp_format",
    action: "lsp.format",
    aliases: ["lsp.format", "LspFormat"],
    title: "LSP Format Preview",
    description: "Preview document formatting edits without applying edits.",
    riskClass: "r0",
    permissionName: "Read",
    inputSchema: objectSchema({ file: "workspace file path", maxResults: "number", timeoutMs: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
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
    name: "AgentList",
    action: "agent.list",
    aliases: ["agent.list", "agents.list"],
    title: "List Agents",
    description: "List recent internal workers and background agents with current status and ids.",
    riskClass: "r0",
    permissionName: "AgentRead",
    inputSchema: objectSchema({ parent_session_id: "optional parent session id", status: "pending | running | completed | failed | stopped", limit: "number" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "AgentStatus",
    action: "agent.status",
    aliases: ["agent.status", "worker.status"],
    title: "Agent Status",
    description: "Inspect one internal worker/background agent by worker_id, including output summary and session references.",
    riskClass: "r0",
    permissionName: "AgentRead",
    inputSchema: objectSchema({ worker_id: "worker id returned by Agent or AgentList" }),
    concurrencyClass: "read_parallel",
    readOnly: true
  },
  {
    name: "AgentStop",
    action: "agent.stop",
    aliases: ["agent.stop", "worker.stop"],
    title: "Stop Agent",
    description: "Request stop for a pending or running internal worker/background agent.",
    riskClass: "r1",
    permissionName: "Agent",
    inputSchema: objectSchema({ worker_id: "worker id" })
  },
  {
    name: "AgentContinue",
    action: "agent.continue",
    aliases: ["agent.continue", "continue_agent", "worker.continue"],
    title: "Continue Agent",
    description: "Recall a completed, failed, or stopped worker with a follow-up instruction using its previous context.",
    riskClass: "r1",
    permissionName: "Agent",
    inputSchema: objectSchema({ worker_id: "worker id", message: "follow-up instruction", run_in_background: "boolean" })
  },
  {
    name: "AgentMessage",
    action: "agent.message",
    aliases: ["agent.message", "SendMessageTool", "SendMessage", "send_message", "agent_message", "worker.message"],
    title: "Message Agent",
    description: "Send a short runtime mailbox message to an existing Swarm worker, actor, role, or capability.",
    riskClass: "r1",
    permissionName: "Agent",
    inputSchema: objectSchema({ message: "message text", worker_id: "optional worker id", agent_id: "optional exact actor id", role: "optional role", capability: "optional capability", require_ack: "boolean", ttl_ms: "number" }),
    concurrencyClass: "write_exclusive"
  },
  {
    name: "RuntimeSleep",
    action: "runtime.sleep",
    aliases: ["runtime.sleep", "SleepTool", "sleep", "runtime_sleep"],
    title: "Wait",
    description: "Wait for a bounded duration without busy-looping or starting a background process.",
    riskClass: "r0",
    permissionName: "RuntimeSleep",
    inputSchema: objectSchema({ duration_ms: "bounded wait duration in milliseconds", reason: "optional reason" }),
    readOnly: true,
    concurrencyClass: "read_parallel"
  },
  {
    name: "StructuredOutput",
    action: "structured.output",
    aliases: ["structured.output", "SyntheticOutputTool", "StructuredOutput", "structured_output", "synthetic.output"],
    title: "Structured Output",
    description: "Record schema-validated output only when a headless or schema-enabled runtime contract allows it.",
    riskClass: "r0",
    permissionName: "StructuredOutput",
    inputSchema: objectSchema({ value: "JSON value", schema: "optional JSON schema object", label: "optional label", final: "boolean" }),
    readOnly: true,
    concurrencyClass: "read_parallel",
    searchHint: "Available only in schema-enabled headless runs; use normal final responses in interactive chat."
  },
  {
    name: "ReplMode",
    action: "repl.mode",
    aliases: ["repl.mode", "REPLTool", "ReplMode", "repl_mode"],
    title: "REPL Mode Guidance",
    description: "Explain current interactive/headless primitive tool visibility without creating a second REPL state machine.",
    riskClass: "r0",
    permissionName: "ReplMode",
    inputSchema: objectSchema({ mode: "interactive | headless | repl", reason: "optional reason" }),
    readOnly: true,
    concurrencyClass: "read_parallel"
  },
  {
    name: "ScheduleCreate",
    action: "schedule.create",
    aliases: ["ScheduleCronTool", "CronCreate", "schedule.create", "cron.create"],
    title: "Create Schedule",
    description: "Design-gated schedule creation surface; returns unavailable guidance until Swarm has a durable scheduler.",
    riskClass: "r1",
    permissionName: "Schedule",
    inputSchema: objectSchema({ cron: "5-field cron expression", prompt: "prompt to run", recurring: "boolean", durable: "boolean", timezone: "string", dry_run: "boolean" }),
    concurrencyClass: "write_exclusive",
    searchHint: "Automation lifecycle control, not a normal coding edit. Currently design-only without durable scheduler runtime."
  },
  {
    name: "ScheduleList",
    action: "schedule.list",
    aliases: ["CronList", "schedule.list", "cron.list"],
    title: "List Schedules",
    description: "Design-gated schedule inventory surface; reports that no durable schedule inventory exists yet.",
    riskClass: "r0",
    permissionName: "Schedule",
    inputSchema: objectSchema({ status: "active | paused | expired", limit: "number" }),
    readOnly: true,
    concurrencyClass: "read_parallel",
    searchHint: "Inspect schedule support status without inventing schedule state."
  },
  {
    name: "ScheduleDelete",
    action: "schedule.delete",
    aliases: ["CronDelete", "schedule.delete", "cron.delete"],
    title: "Delete Schedule",
    description: "Design-gated exact-id schedule deletion surface; unavailable until Swarm owns durable schedules.",
    riskClass: "r1",
    permissionName: "Schedule",
    inputSchema: objectSchema({ schedule_id: "exact schedule id", reason: "optional reason", dry_run: "boolean" }),
    concurrencyClass: "write_exclusive",
    searchHint: "Automation lifecycle control that requires exact ids and future audit support."
  },
  {
    name: "RemoteTrigger",
    action: "remote.trigger",
    aliases: ["RemoteTriggerTool", "remote.trigger", "remote_trigger"],
    title: "Remote Trigger",
    description: "Design-gated remote automation boundary; requires explicit endpoint configuration and no implicit credentials.",
    riskClass: "r1",
    permissionName: "RemoteTrigger",
    inputSchema: objectSchema({ endpoint: "configured endpoint id", capability: "remote capability", payload: "JSON payload", dry_run: "boolean" }),
    concurrencyClass: "network_limited",
    searchHint: "Use MCP tools for configured integrations; remote.trigger is unavailable until explicit endpoints exist."
  },
  {
    name: "TeamCreate",
    action: "team.create",
    aliases: ["TeamCreateTool", "team.create", "team_create"],
    title: "Create Team",
    description: "Design-gated team lifecycle surface; future implementation must compose existing tasks and agents.",
    riskClass: "r1",
    permissionName: "Team",
    inputSchema: objectSchema({ name: "optional name", objective: "team objective", roles: "string[]", task_ids: "string[]", dry_run: "boolean" }),
    concurrencyClass: "write_exclusive",
    searchHint: "Use task.create and agent.delegate today; team.create is a lifecycle design surface."
  },
  {
    name: "TeamDelete",
    action: "team.delete",
    aliases: ["TeamDeleteTool", "team.delete", "team_delete"],
    title: "Delete Team",
    description: "Design-gated exact-id team deletion surface; unavailable until Swarm has a team projection and audit trail.",
    riskClass: "r1",
    permissionName: "Team",
    inputSchema: objectSchema({ team_id: "exact team id", reason: "optional reason", dry_run: "boolean" }),
    concurrencyClass: "write_exclusive",
    searchHint: "Use task.stop or agent.stop for current workers/tasks; team.delete needs future team ids."
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
    return BUILTIN_TOOLS.map((tool) => {
      const descriptor: CapabilityDescriptor = {
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
        alwaysLoad: tool.alwaysLoad,
        shouldDefer: tool.shouldDefer ?? false,
        readOnly: tool.readOnly ?? builtinToolReadOnly(tool),
        concurrencyClass: tool.concurrencyClass ?? builtinToolConcurrencyClass(tool),
        metadata: {
          action: tool.action ?? tool.name,
          aliases: tool.aliases
        }
      };
      if (tool.maxResultBytes !== undefined) {
        descriptor.maxResultBytes = tool.maxResultBytes;
      }
      if (tool.searchHint) {
        descriptor.searchHint = tool.searchHint;
      }
      return descriptor;
    });
  }
}

function builtinToolReadOnly(tool: BuiltinToolDescriptor): boolean {
  if (tool.name.startsWith("lsp_")) {
    return true;
  }
  return [
    "Read",
    "LS",
    "Glob",
    "Grep",
    "file.stat",
    "AgentList",
    "AgentStatus",
    "RuntimeSleep",
    "StructuredOutput",
    "ReplMode",
    "ProcessStatus",
    "ProcessList",
    "ProcessTail",
    "ProcessGrep",
    "ScheduleList",
    "McpResources",
    "McpRead",
    "McpAuth",
    "WebSearch",
    "WebFetch",
    "git.status",
    "git.diff",
    "git.log"
  ].includes(tool.name);
}

function builtinToolConcurrencyClass(tool: BuiltinToolDescriptor): CapabilityDescriptor["concurrencyClass"] {
  if (tool.name.startsWith("lsp_")) {
    return "read_parallel";
  }
  if ([
    "Read",
    "LS",
    "Glob",
    "Grep",
    "file.stat",
    "AgentList",
    "AgentStatus",
    "ProcessStatus",
    "ProcessList",
    "ProcessTail",
    "ProcessGrep",
    "ScheduleList",
    "McpResources",
    "McpRead",
    "McpAuth",
    "RuntimeSleep",
    "StructuredOutput",
    "ReplMode",
    "git.status",
    "git.diff",
    "git.log"
  ].includes(tool.name)) {
    return "read_parallel";
  }
  if (tool.name === "ProcessStart") {
    return "background_process";
  }
  if (tool.name === "WebSearch" || tool.name === "WebFetch" || tool.name === "McpCall" || tool.name === "SkillInvoke" || tool.name === "RemoteTrigger") {
    return "network_limited";
  }
  if (tool.name === "Bash" || tool.name === "PowerShell" || tool.name === "exec" || tool.name === "code.test" || tool.name === "code.lint" || tool.name === "package.install") {
    return "verify_exclusive";
  }
  return "write_exclusive";
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
