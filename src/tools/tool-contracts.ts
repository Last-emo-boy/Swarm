import type { ToolAction } from "./types.js";

export type LocalToolRequiredWhen = {
  when: Record<string, string | number | boolean | null>;
  required?: string[];
  required_any?: string[][];
};

export type LocalToolSchema = {
  action: string;
  inputs: Record<string, unknown>;
  input_schema?: LocalToolInputSchema;
  notes?: string;
  required?: string[];
  required_any?: string[][];
  required_when?: LocalToolRequiredWhen[];
};

export type LocalToolInputSchema = {
  type: "object";
  properties: Record<string, LocalToolInputPropertySchema>;
  required?: string[];
  allOf?: LocalToolInputSchemaClause[];
  additionalProperties: boolean;
};

export type LocalToolInputPropertySchema = {
  type?: string | string[];
  description?: string;
  items?: LocalToolInputPropertySchema;
  enum?: string[];
  additionalProperties?: boolean;
};

export type LocalToolInputSchemaClause = {
  anyOf?: Array<{ required: string[] }>;
  if?: {
    properties: Record<string, { const: string | number | boolean | null }>;
    required: string[];
  };
  then?: {
    required?: string[];
    allOf?: LocalToolInputSchemaClause[];
  };
};

export const LOCAL_TOOL_SCHEMAS: Record<string, LocalToolSchema> = {
  "Read": {
    action: "Read",
    inputs: { file_path: "file path", offset: "optional line offset", limit: "optional line count", path: "compat path" },
    required_any: [["file_path", "path", "paths"]],
    notes: "Use a full Read before editing an existing file."
  },
  "LS": {
    action: "LS",
    inputs: { path: "directory path", root: "compat directory path", maxFiles: "optional number", maxDepth: "optional number" }
  },
  "Glob": {
    action: "Glob",
    inputs: { pattern: "glob pattern", path: "optional directory path" },
    required: ["pattern"]
  },
  "Grep": {
    action: "Grep",
    inputs: { pattern: "regex pattern", path: "optional file or directory path", glob: "optional glob", output_mode: "content | files_with_matches | count", context: "optional number", "-A": "optional after context", "-B": "optional before context", head_limit: "optional number", offset: "optional number", "-i": "optional boolean", type: "optional file type such as ts/js/py", multiline: "optional boolean" },
    required: ["pattern"]
  },
  "Write": {
    action: "Write",
    inputs: { file_path: "workspace path", content: "complete file content", path: "compat path" },
    required: ["content"],
    required_any: [["file_path", "path"]],
    notes: "Use for new files or complete replacement. Prefer Edit for existing files after a full Read."
  },
  "Edit": {
    action: "Edit",
    inputs: { file_path: "workspace path", old_string: "must match exactly once unless replace_all=true", new_string: "replacement", replace_all: "optional boolean", path: "compat path" },
    required: ["old_string", "new_string"],
    required_any: [["file_path", "path"]]
  },
  "NotebookEdit": {
    action: "NotebookEdit",
    inputs: { notebook_path: "ipynb path", cell_id: "optional cell id", new_source: "cell source", cell_type: "code | markdown", edit_mode: "replace | insert | delete" },
    required: ["notebook_path"]
  },
  "Bash": {
    action: "Bash",
    inputs: { command: "command string", timeout: "optional ms", description: "optional concise description", run_in_background: "boolean for persistent commands", cwd: "optional cwd", maxLogBytes: "optional background log cap" },
    required: ["command"],
    notes: "Use run_in_background=true or ProcessStart for servers, dev servers, watchers, and commands whose logs must be inspected later."
  },
  "PowerShell": {
    action: "PowerShell",
    inputs: { command: "PowerShell command string", timeout: "optional ms", description: "optional concise description", run_in_background: "boolean for persistent commands", cwd: "optional cwd", maxOutputBytes: "optional output cap", maxLogBytes: "optional background log cap" },
    required: ["command"],
    notes: "Use for Windows-native commands that require PowerShell syntax. Prefer Bash only for cross-platform shell commands."
  },
  "ProcessStart": {
    action: "ProcessStart",
    inputs: { command: "persistent command string", cwd: "optional workspace-relative cwd", description: "short label", timeoutMs: "optional maximum lifetime in ms", maxLogBytes: "optional log cap in bytes" },
    required: ["command"],
    notes: "Starts a command in the background and returns processId plus logPath immediately. Use for backend servers, dev servers, and watchers."
  },
  "ProcessStatus": {
    action: "ProcessStatus",
    inputs: { processId: "optional process id; omit to list recent session processes", sessionId: "optional session id" }
  },
  "ProcessList": {
    action: "ProcessList",
    inputs: { sessionId: "optional session id", status: "optional running | completed | failed | stopped | unknown", limit: "optional number" }
  },
  "ProcessTail": {
    action: "ProcessTail",
    inputs: { processId: "process id", sessionId: "optional session id", lines: "optional line count", maxBytes: "optional byte cap" },
    required: ["processId"]
  },
  "ProcessGrep": {
    action: "ProcessGrep",
    inputs: { processId: "process id", sessionId: "optional session id", pattern: "regex or literal text", maxMatches: "optional number", contextLines: "optional number" },
    required: ["processId", "pattern"]
  },
  "ProcessStop": {
    action: "ProcessStop",
    inputs: { processId: "process id", sessionId: "optional session id" },
    required: ["processId"],
    notes: "Stops a running background process."
  },
  "exec": {
    action: "exec",
    inputs: { command: "command string", cwd: "optional workspace-relative cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes" },
    required: ["command"]
  },
  "WebSearch": {
    action: "WebSearch",
    inputs: { query: "search query", allowed_domains: "optional string[]", blocked_domains: "optional string[]" },
    required: ["query"]
  },
  "WebFetch": {
    action: "WebFetch",
    inputs: { url: "http(s) URL", prompt: "what to extract from the page", timeoutMs: "optional ms", maxBytes: "optional bytes" },
    required: ["url"]
  },
  "Config": {
    action: "Config",
    inputs: { setting: "safe setting key; omit value to read", value: "optional string | number | boolean | null to write the setting" },
    required: ["setting"],
    notes: "Reads or writes only Swarm's explicit safe settings allowlist. Secrets and API keys are never returned."
  },
  "McpResources": {
    action: "McpResources",
    inputs: { server: "optional MCP server id", limit: "optional result limit" },
    notes: "Lists configured MCP resources with recoverable server/auth status messages."
  },
  "McpRead": {
    action: "McpRead",
    inputs: { server: "MCP server id", uri: "resource URI", maxBytes: "optional byte budget" },
    required: ["server", "uri"],
    notes: "Reads one MCP resource and truncates or persists large output when available."
  },
  "McpAuth": {
    action: "McpAuth",
    inputs: { server: "optional MCP server id" },
    notes: "Reports MCP auth/connection state and recovery steps without exposing credentials."
  },
  "McpCall": {
    action: "McpCall",
    inputs: { server: "optional MCP server id", tool: "MCP tool name", capabilityId: "optional exact capability id", args: "optional JSON object", maxBytes: "optional byte budget" },
    required_any: [["capabilityId"], ["server", "tool"]],
    notes: "Calls a configured MCP tool through the capability broker; mutable MCP tools still follow permission policy."
  },
  "SkillInvoke": {
    action: "SkillInvoke",
    inputs: { name: "trusted skill name", reason: "optional activation reason" },
    required: ["name"],
    notes: "Activates one trusted skill and writes durable context through the existing runtime skill path."
  },
  "TodoWrite": {
    action: "TodoWrite",
    inputs: { todos: "array of {content:string,activeForm?:string,status:'pending'|'in_progress'|'completed'}" }
  },
  "AskUserQuestion": {
    action: "AskUserQuestion",
    inputs: { prompt: "clear question text", questions: "optional array of structured questions", choices: "optional array of {label:string,description?:string}", defaultChoice: "optional default choice label", recommendedChoice: "optional recommended choice label", allowFreeform: "optional boolean", reason: "optional reason this question is blocking" },
    required: ["prompt"],
    notes: "Use only for genuinely blocking user choices. Returns a recoverable waiting result until the user answers."
  },
  "EnterPlanMode": {
    action: "EnterPlanMode",
    inputs: { objective: "optional task objective", reason: "optional reason planning mode is useful" },
    notes: "Use before non-trivial implementation work that needs exploration and user-visible planning."
  },
  "ExitPlanMode": {
    action: "ExitPlanMode",
    inputs: { plan: "implementation plan to present for approval", summary: "optional short summary", ready: "optional boolean", allowedPrompts: "optional array of {tool:string,prompt:string}" },
    required: ["plan"],
    notes: "Use after writing the implementation plan. Returns a recoverable waiting result for approval."
  },
  "EnterWorktree": {
    action: "EnterWorktree",
    inputs: { name: "optional short worktree name", branch: "optional branch name; defaults to swarm/worktree/<name>" },
    notes: "Creates an isolated git worktree for the current session and updates the session workspace lease. Use only when the user explicitly asks for worktree isolation."
  },
  "ExitWorktree": {
    action: "ExitWorktree",
    inputs: { mode: "keep | remove", discard_changes: "optional boolean; required to remove a dirty worktree" },
    notes: "Leaves the active session worktree. keep preserves the directory and branch; remove deletes only a Swarm-created worktree after safety checks."
  },
  "BlackboardWrite": {
    action: "BlackboardWrite",
    inputs: { key: "stable dotted key", type: "plan | observation | evidence | result | critique | decision | artifact", value: "JSON-serializable value", visibility: "optional private | team | public", tags: "optional string[]" },
    required: ["key", "type"],
    notes: "Write shared Swarm session state for other agents. Do not construct raw envelopes."
  },
  "BlackboardSearch": {
    action: "BlackboardSearch",
    inputs: { query: "optional text search", type: "optional entry type", tag: "optional tag", key_prefix: "optional key prefix", task_id: "optional task id", agent_id: "optional agent id", limit: "optional number" }
  },
  "BlackboardRead": {
    action: "BlackboardRead",
    inputs: { entry_id: "entry id", key: "entry key", limit: "optional number for key history" },
    required_any: [["entry_id", "key"]]
  },
  "BlackboardList": {
    action: "BlackboardList",
    inputs: { type: "optional entry type", tag: "optional tag", key_prefix: "optional key prefix", task_id: "optional task id", agent_id: "optional agent id", limit: "optional number" }
  },
  "ToolSearch": {
    action: "ToolSearch",
    inputs: { query: "search text or capability hint", limit: "optional max results", kind: "optional capability kind", provider: "optional provider id" },
    notes: "Use to discover deferred MCP tools or named skills before calling them. Deferred MCP schemas become available on the next turn."
  },
  "Agent": {
    action: "Agent",
    inputs: { description: "short task description", prompt: "task for the agent", subagent_type: "optional agent type", model: "optional model", run_in_background: "optional boolean; launch without blocking the main agent", capability: "compat capability", task: "compat task", file_scope: "optional string[]" },
    required_any: [["prompt", "task", "description", "objective"]]
  },
  "AgentList": {
    action: "AgentList",
    inputs: { parent_session_id: "optional parent session id; defaults to current session when available", status: "optional pending | running | completed | failed | stopped", limit: "optional number" }
  },
  "AgentStatus": {
    action: "AgentStatus",
    inputs: { worker_id: "worker id returned by Agent or AgentList" },
    required: ["worker_id"]
  },
  "AgentStop": {
    action: "AgentStop",
    inputs: { worker_id: "running or pending worker id" },
    required: ["worker_id"]
  },
  "AgentContinue": {
    action: "AgentContinue",
    inputs: { worker_id: "completed/failed/stopped worker id to recall", message: "follow-up instruction for the recalled worker context", run_in_background: "optional boolean; launch the continuation without blocking" },
    required: ["worker_id", "message"]
  },
  "AgentMessage": {
    action: "AgentMessage",
    inputs: { worker_id: "optional worker id", agent_id: "optional exact agent actor id", role: "optional target role", capability: "optional target capability", message: "message to deliver", require_ack: "optional boolean", ttl_ms: "optional ms" },
    required: ["message"],
    required_any: [["worker_id"], ["agent_id"], ["role"], ["capability"]],
    notes: "Sends a peer message through the existing Swarm mailbox/envelope runtime. Use agent.list first to find worker ids."
  },
  "RuntimeSleep": {
    action: "RuntimeSleep",
    inputs: { duration_ms: "bounded wait duration in ms", reason: "optional wait reason" },
    required: ["duration_ms"],
    notes: "Use only for short cooldowns or polling gaps. The wait is bounded and does not create a background process."
  },
  "StructuredOutput": {
    action: "StructuredOutput",
    inputs: { value: "JSON value to validate/record", schema: "optional JSON schema object", label: "optional label", final: "optional boolean" },
    required: ["value"],
    notes: "Headless/schema-enabled output contract tool. Normal interactive chat should return final text instead."
  },
  "ReplMode": {
    action: "ReplMode",
    inputs: { mode: "optional interactive | headless | repl", reason: "optional reason" },
    notes: "Reports Swarm's current REPL/headless tool visibility guidance without creating a second REPL state machine."
  },
  "TaskCreate": {
    action: "TaskCreate",
    inputs: { title: "task title", objective: "optional objective", description: "optional details", task_id: "optional stable id", session_id: "optional session id; defaults to current session", status: "optional pending | running | completed | failed | blocked | cancelled", capability: "optional capability", required_capabilities: "optional string[]", file_scope: "optional string[]" },
    required: ["title"],
    notes: "Creates a tracked task in the current Swarm session using existing task state stores."
  },
  "TaskUpdate": {
    action: "TaskUpdate",
    inputs: { task_id: "task id", session_id: "optional session id", status: "optional task status", summary: "optional progress/result summary", output: "optional output to persist", output_ref: "optional existing output ref", last_error: "optional error text", progress: "optional number" },
    required: ["task_id"],
    notes: "Updates progress/result state for an existing tracked task."
  },
  "TaskGet": {
    action: "TaskGet",
    inputs: { task_id: "task id", session_id: "optional session id" },
    required: ["task_id"]
  },
  "TaskList": {
    action: "TaskList",
    inputs: { session_id: "optional session id; defaults to current session", status: "optional task status", limit: "optional number", offset: "optional number" }
  },
  "TaskOutput": {
    action: "TaskOutput",
    inputs: { task_id: "optional task id", worker_id: "optional worker id", session_id: "optional session id", output_ref: "optional persisted output path/ref", max_bytes: "optional byte budget", offset: "optional byte offset" },
    required_any: [["task_id", "worker_id", "output_ref"]]
  },
  "TaskStop": {
    action: "TaskStop",
    inputs: { task_id: "task or worker id to stop", session_id: "optional session id", reason: "optional cancellation reason" },
    required: ["task_id"]
  },
  "file.read": {
    action: "file.read",
    inputs: {
      action: "file.read",
      path: "string path, or use paths",
      paths: "optional string[] for multiple small files",
      startLine: "optional 1-based line number",
      endLine: "optional 1-based line number; -1 means EOF",
      maxBytes: "optional byte budget"
    },
    required_any: [["path", "paths"]],
    notes: "Use a full file.read before editing an existing file."
  },
  "file.list": {
    action: "file.list",
    inputs: { action: "file.list", root: "directory path", maxFiles: "optional number", maxDepth: "optional number" }
  },
  "file.glob": {
    action: "file.glob",
    inputs: { action: "file.glob", root: "directory path", pattern: "glob pattern", maxResults: "optional number", maxDepth: "optional number" },
    required: ["pattern"]
  },
  "file.grep": {
    action: "file.grep",
    inputs: { action: "file.grep", root: "file or directory path", pattern: "regex pattern", include: "optional glob", outputMode: "content | files_with_matches | count", maxMatches: "compat optional number", headLimit: "optional number; 0 means unlimited", offset: "optional number", contextLines: "optional number", beforeContext: "optional number", afterContext: "optional number", caseInsensitive: "optional boolean", multiline: "optional boolean", fileType: "optional file type such as ts/js/py" },
    required: ["pattern"]
  },
  "file.stat": {
    action: "file.stat",
    inputs: { action: "file.stat", path: "path" },
    required: ["path"]
  },
  "file.resolve": {
    action: "file.resolve",
    inputs: { action: "file.resolve", path: "path" },
    required: ["path"]
  },
  "file.write": {
    action: "file.write",
    inputs: { action: "file.write", path: "workspace path", content: "complete file content" },
    required: ["path", "content"],
    notes: "Use for new files or complete replacement. Prefer file.edit for existing files after a full read."
  },
  "file.edit": {
    action: "file.edit",
    inputs: {
      action: "file.edit",
      path: "workspace path",
      operation: "str_replace | insert",
      oldText: "required for str_replace; must match exactly once",
      newText: "replacement text for str_replace",
      line: "1-based insertion line for insert",
      content: "inserted text for insert"
    },
    required: ["path"],
    required_when: [
      { when: { operation: "insert" }, required_any: [["content", "newText"]] },
      { when: { operation: "str_replace" }, required: ["oldText"] }
    ]
  },
  "file.mkdir": {
    action: "file.mkdir",
    inputs: { action: "file.mkdir", path: "workspace path", recursive: "optional boolean" },
    required: ["path"]
  },
  "file.move": {
    action: "file.move",
    inputs: { action: "file.move", source: "source path", destination: "destination path", overwrite: "optional boolean" },
    required: ["source", "destination"]
  },
  "file.copy": {
    action: "file.copy",
    inputs: { action: "file.copy", source: "source path", destination: "destination path", overwrite: "optional boolean", recursive: "optional boolean" },
    required: ["source", "destination"]
  },
  "file.delete": {
    action: "file.delete",
    inputs: { action: "file.delete", path: "workspace path", recursive: "optional boolean" },
    required: ["path"]
  },
  "file.patch": {
    action: "file.patch",
    inputs: { action: "file.patch", path: "workspace path", hunks: "array of {oldText:string,newText:string}" },
    required: ["path", "hunks"]
  },
  "json.read": {
    action: "json.read",
    inputs: { action: "json.read", path: "JSON file path", pointer: "optional JSON pointer" },
    required: ["path"]
  },
  "json.edit": {
    action: "json.edit",
    inputs: { action: "json.edit", path: "JSON file path", operation: "set | delete | merge", pointer: "JSON pointer", value: "value for set/merge" },
    required: ["path", "pointer"]
  },
  "shell.exec": {
    action: "shell.exec",
    inputs: { action: "shell.exec", command: "command string", cwd: "optional workspace-relative cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes", run_in_background: "optional boolean", description: "optional label", maxLogBytes: "optional bytes" },
    required: ["command"]
  },
  "powershell.exec": {
    action: "powershell.exec",
    inputs: { action: "powershell.exec", command: "PowerShell command string", cwd: "optional workspace-relative cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes", run_in_background: "optional boolean", description: "optional label", maxLogBytes: "optional bytes" },
    required: ["command"],
    notes: "Runs through powershell.exe -NoProfile -Command on Windows and pwsh/powershell fallback elsewhere when available."
  },
  "process.start": {
    action: "process.start",
    inputs: { action: "process.start", command: "persistent command string", cwd: "optional cwd", description: "short label", timeoutMs: "optional ms", maxLogBytes: "optional bytes" },
    required: ["command"]
  },
  "process.status": {
    action: "process.status",
    inputs: { action: "process.status", processId: "optional process id", sessionId: "optional session id" }
  },
  "process.list": {
    action: "process.list",
    inputs: { action: "process.list", sessionId: "optional session id", status: "optional status", limit: "optional number" }
  },
  "process.tail": {
    action: "process.tail",
    inputs: { action: "process.tail", processId: "process id", sessionId: "optional session id", lines: "optional number", maxBytes: "optional bytes" },
    required: ["processId"]
  },
  "process.grep": {
    action: "process.grep",
    inputs: { action: "process.grep", processId: "process id", sessionId: "optional session id", pattern: "regex or literal", maxMatches: "optional number", contextLines: "optional number" },
    required: ["processId", "pattern"]
  },
  "process.stop": {
    action: "process.stop",
    inputs: { action: "process.stop", processId: "process id", sessionId: "optional session id" },
    required: ["processId"]
  },
  "code.test": {
    action: "code.test",
    inputs: { action: "code.test", command: "test/check command string", cwd: "optional cwd", timeoutMs: "optional ms" },
    required: ["command"]
  },
  "code.lint": {
    action: "code.lint",
    inputs: { action: "code.lint", root: "optional root", include: "optional glob" }
  },
  "code.build": {
    action: "code.build",
    inputs: { action: "code.build", command: "build command string", cwd: "optional cwd", timeoutMs: "optional ms", maxOutputBytes: "optional bytes" },
    required: ["command"]
  },
  "lsp.diagnostics": {
    action: "lsp.diagnostics",
    inputs: { action: "lsp.diagnostics", path: "workspace file path", file: "compat workspace file path", root: "optional workspace root", provider: "optional provider id", maxItems: "optional number", timeoutMs: "optional ms" },
    required_any: [["path", "file"]]
  },
  "lsp.hover": {
    action: "lsp.hover",
    inputs: { action: "lsp.hover", path: "workspace file path", file: "compat workspace file path", line: "1-based line", character: "0-based character", column: "compat 1-based column", timeoutMs: "optional ms" },
    required: ["line"],
    required_any: [["path", "file"]]
  },
  "lsp.definition": {
    action: "lsp.definition",
    inputs: { action: "lsp.definition", path: "workspace file path", file: "compat workspace file path", line: "1-based line", character: "0-based character", column: "compat 1-based column", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["line"],
    required_any: [["path", "file"]]
  },
  "lsp.references": {
    action: "lsp.references",
    inputs: { action: "lsp.references", path: "workspace file path", file: "compat workspace file path", line: "1-based line", character: "0-based character", column: "compat 1-based column", includeDeclaration: "optional boolean", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["line"],
    required_any: [["path", "file"]]
  },
  "lsp.document_symbols": {
    action: "lsp.document_symbols",
    inputs: { action: "lsp.document_symbols", path: "workspace file path", file: "compat workspace file path", maxItems: "optional number", timeoutMs: "optional ms" },
    required_any: [["path", "file"]]
  },
  "lsp.workspace_symbols": {
    action: "lsp.workspace_symbols",
    inputs: { action: "lsp.workspace_symbols", query: "symbol query", root: "optional workspace root", provider: "optional provider id", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["query"]
  },
  "lsp.completion": {
    action: "lsp.completion",
    inputs: { action: "lsp.completion", path: "workspace file path", file: "compat workspace file path", line: "1-based line", character: "0-based character", column: "compat 1-based column", triggerCharacter: "optional trigger character", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["line"],
    required_any: [["path", "file"]]
  },
  "lsp.code_actions": {
    action: "lsp.code_actions",
    inputs: { action: "lsp.code_actions", path: "workspace file path", file: "compat workspace file path", startLine: "1-based start line", startCharacter: "0-based start character", endLine: "1-based end line", endCharacter: "0-based end character", range: "compat {start,end}", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["startLine", "endLine"],
    required_any: [["path", "file"]]
  },
  "lsp.rename_preview": {
    action: "lsp.rename_preview",
    inputs: { action: "lsp.rename_preview", path: "workspace file path", file: "compat workspace file path", line: "1-based line", character: "0-based character", column: "compat 1-based column", newName: "new symbol name", maxItems: "optional number", timeoutMs: "optional ms" },
    required: ["line", "newName"],
    required_any: [["path", "file"]]
  },
  "lsp.format": {
    action: "lsp.format",
    inputs: { action: "lsp.format", path: "workspace file path", file: "compat workspace file path", maxItems: "optional number", timeoutMs: "optional ms" },
    required_any: [["path", "file"]]
  },
  "git.status": {
    action: "git.status",
    inputs: { action: "git.status", cwd: "optional cwd" }
  },
  "git.diff": {
    action: "git.diff",
    inputs: { action: "git.diff", cwd: "optional cwd", staged: "optional boolean" }
  },
  "git.log": {
    action: "git.log",
    inputs: { action: "git.log", cwd: "optional cwd", maxCommits: "optional number" }
  },
  "git.branch": {
    action: "git.branch",
    inputs: { action: "git.branch", cwd: "optional cwd", operation: "optional list | create | switch", name: "branch name for create/switch" },
    required_when: [
      { when: { action: "create" }, required: ["name"] },
      { when: { action: "switch" }, required: ["name"] }
    ]
  },
  "git.show": {
    action: "git.show",
    inputs: { action: "git.show", cwd: "optional cwd", revision: "optional revision/ref", path: "optional file path", maxOutputBytes: "optional bytes" }
  },
  "web.search": {
    action: "web.search",
    inputs: { action: "web.search", query: "search query", allowed_domains: "optional string[]", blocked_domains: "optional string[]", maxUses: "optional number" },
    required: ["query"]
  },
  "web.fetch": {
    action: "web.fetch",
    inputs: { action: "web.fetch", url: "http(s) URL", prompt: "optional extraction prompt", timeoutMs: "optional ms", maxBytes: "optional bytes" },
    required: ["url"]
  },
  "config.get": {
    action: "config.get",
    inputs: { action: "config.get", setting: "optional safe setting key; omit to list safe settings" },
    notes: "Never returns plaintext API keys, tokens, headers, or credentials."
  },
  "config.set": {
    action: "config.set",
    inputs: { action: "config.set", setting: "safe setting key", value: "string | number | boolean | null" },
    required: ["setting", "value"],
    notes: "Writes only Swarm's explicit safe settings allowlist."
  },
  "mcp.resources": {
    action: "mcp.resources",
    inputs: { action: "mcp.resources", server: "optional MCP server id", limit: "optional result limit" }
  },
  "mcp.read": {
    action: "mcp.read",
    inputs: { action: "mcp.read", server: "MCP server id", uri: "resource URI", maxBytes: "optional byte budget" },
    required: ["server", "uri"]
  },
  "mcp.auth": {
    action: "mcp.auth",
    inputs: { action: "mcp.auth", server: "optional MCP server id" }
  },
  "mcp.call": {
    action: "mcp.call",
    inputs: { action: "mcp.call", server: "optional MCP server id", tool: "MCP tool name", capabilityId: "optional exact capability id", args: "optional JSON object", maxBytes: "optional byte budget" },
    required_any: [["capabilityId"], ["server", "tool"]]
  },
  "skill.invoke": {
    action: "skill.invoke",
    inputs: { action: "skill.invoke", name: "trusted skill name", reason: "optional activation reason" },
    required: ["name"]
  },
  "todo.write": {
    action: "todo.write",
    inputs: {
      action: "todo.write",
      todos: "array of {content:string,status:'pending'|'in_progress'|'completed'}"
    },
    required: ["todos"]
  },
  "ask_user_question": {
    action: "ask_user_question",
    inputs: {
      action: "ask_user_question",
      prompt: "clear question text",
      questions: "optional array of structured questions",
      choices: "optional array of {label:string,description?:string}",
      defaultChoice: "optional default choice label",
      recommendedChoice: "optional recommended choice label",
      allowFreeform: "optional boolean",
      reason: "optional reason this question is blocking"
    },
    required: ["prompt"],
    notes: "Use only for genuinely blocking user choices. Returns a recoverable waiting result until the user answers."
  },
  "plan.enter": {
    action: "plan.enter",
    inputs: { action: "plan.enter", objective: "optional task objective", reason: "optional reason planning mode is useful" },
    notes: "Use before non-trivial implementation work that needs exploration and user-visible planning."
  },
  "plan.exit": {
    action: "plan.exit",
    inputs: { action: "plan.exit", plan: "implementation plan to present for approval", summary: "optional short summary", ready: "optional boolean", allowedPrompts: "optional array of {tool:string,prompt:string}" },
    required: ["plan"],
    notes: "Use after writing the implementation plan. Returns a recoverable waiting result for approval."
  },
  "worktree.enter": {
    action: "worktree.enter",
    inputs: { action: "worktree.enter", name: "optional short worktree name", branch: "optional branch name; defaults to swarm/worktree/<name>" },
    notes: "Creates an isolated git worktree for the current session and updates the session workspace lease. Use only when the user explicitly asks for worktree isolation."
  },
  "worktree.exit": {
    action: "worktree.exit",
    inputs: { action: "worktree.exit", mode: "keep | remove", discardChanges: "optional boolean; required to remove a dirty worktree" },
    notes: "Leaves the active session worktree. keep preserves the directory and branch; remove deletes only a Swarm-created worktree after safety checks."
  },
  "notebook.edit": {
    action: "notebook.edit",
    inputs: { action: "notebook.edit", notebookPath: "ipynb path", cellId: "optional cell id", newSource: "cell source", cellType: "code | markdown", editMode: "replace | insert | delete" },
    required: ["notebookPath"]
  },
  "package.install": {
    action: "package.install",
    inputs: { action: "package.install", command: "package install command", cwd: "optional cwd", timeoutMs: "optional ms" },
    required: ["command"]
  },
  "package.info": {
    action: "package.info",
    inputs: { action: "package.info", cwd: "optional cwd", manifest: "optional package manifest path" }
  },
  "project.detect": {
    action: "project.detect",
    inputs: { action: "project.detect", root: "optional root/cwd/path" }
  },
  "blackboard.write": {
    action: "blackboard.write",
    inputs: { action: "blackboard.write", key: "stable dotted key", entryType: "entry type", type: "compat entry type", value: "JSON value", visibility: "optional private | team | public", tags: "optional string[]" },
    required: ["key"],
    required_any: [["entryType", "type"]]
  },
  "blackboard.search": {
    action: "blackboard.search",
    inputs: { action: "blackboard.search", query: "optional text search", type: "optional entry type", tag: "optional tag", keyPrefix: "optional key prefix", taskId: "optional task id", agentId: "optional agent id", limit: "optional number" }
  },
  "blackboard.read": {
    action: "blackboard.read",
    inputs: { action: "blackboard.read", entryId: "entry id", key: "entry key", limit: "optional number" },
    required_any: [["entryId", "key"]]
  },
  "blackboard.list": {
    action: "blackboard.list",
    inputs: { action: "blackboard.list", type: "optional entry type", tag: "optional tag", keyPrefix: "optional key prefix", taskId: "optional task id", agentId: "optional agent id", limit: "optional number" }
  },
  "agent.list": {
    action: "agent.list",
    inputs: { action: "agent.list", parent_session_id: "optional parent session id; defaults to current session when available", status: "optional pending | running | completed | failed | stopped", limit: "optional number" }
  },
  "agent.status": {
    action: "agent.status",
    inputs: { action: "agent.status", worker_id: "worker id returned by agent.delegate or agent.list" },
    required: ["worker_id"]
  },
  "agent.stop": {
    action: "agent.stop",
    inputs: { action: "agent.stop", worker_id: "running or pending worker id" },
    required: ["worker_id"]
  },
  "agent.continue": {
    action: "agent.continue",
    inputs: { action: "agent.continue", worker_id: "completed/failed/stopped worker id to recall", message: "follow-up instruction for the recalled worker context", run_in_background: "optional boolean; launch the continuation without blocking" },
    required: ["worker_id", "message"]
  },
  "agent.message": {
    action: "agent.message",
    inputs: { action: "agent.message", worker_id: "optional worker id", agent_id: "optional exact agent actor id", role: "optional target role", capability: "optional target capability", message: "message to deliver", require_ack: "optional boolean", ttl_ms: "optional ms" },
    required: ["message"],
    required_any: [["worker_id"], ["agent_id"], ["role"], ["capability"]],
    notes: "Sends a peer message through the existing Swarm mailbox/envelope runtime. Use agent.list first to find worker ids."
  },
  "runtime.sleep": {
    action: "runtime.sleep",
    inputs: { action: "runtime.sleep", duration_ms: "bounded wait duration in ms", reason: "optional wait reason" },
    required: ["duration_ms"],
    notes: "Use only for short cooldowns or polling gaps. The wait is bounded and does not create a background process."
  },
  "structured.output": {
    action: "structured.output",
    inputs: { action: "structured.output", value: "JSON value to validate/record", schema: "optional JSON schema object", label: "optional label", final: "optional boolean" },
    required: ["value"],
    notes: "Headless/schema-enabled output contract tool. Normal interactive chat should return final text instead."
  },
  "repl.mode": {
    action: "repl.mode",
    inputs: { action: "repl.mode", mode: "optional interactive | headless | repl", reason: "optional reason" },
    notes: "Reports Swarm's current REPL/headless tool visibility guidance without creating a second REPL state machine."
  },
  "ScheduleCreate": {
    action: "ScheduleCreate",
    inputs: { cron: "5-field cron expression", prompt: "prompt to run", recurring: "optional boolean", durable: "optional boolean", timezone: "optional timezone", dry_run: "optional boolean" },
    required: ["cron", "prompt"],
    notes: "Design-gated automation surface. Returns recoverable unavailable guidance until Swarm has a durable scheduler daemon/store."
  },
  "ScheduleList": {
    action: "ScheduleList",
    inputs: { status: "optional active | paused | expired", limit: "optional number" },
    notes: "Design-gated schedule inventory surface. It does not invent schedule state when no durable scheduler exists."
  },
  "ScheduleDelete": {
    action: "ScheduleDelete",
    inputs: { schedule_id: "exact schedule id", reason: "optional reason", dry_run: "optional boolean" },
    required: ["schedule_id"],
    notes: "Design-gated exact-id schedule deletion surface. Must be permission-gated if durable schedules are implemented later."
  },
  "RemoteTrigger": {
    action: "RemoteTrigger",
    inputs: { endpoint: "optional configured endpoint id", capability: "optional remote capability", payload: "optional JSON payload", dry_run: "optional boolean" },
    notes: "Design-gated remote integration boundary. Requires explicit configured endpoints and never uses implicit credentials."
  },
  "TeamCreate": {
    action: "TeamCreate",
    inputs: { name: "optional team name", objective: "team objective", roles: "optional role list", task_ids: "optional existing task ids", dry_run: "optional boolean" },
    required: ["objective"],
    notes: "Design-gated team lifecycle surface. Future implementation must compose existing agent/task primitives instead of a second team store."
  },
  "TeamDelete": {
    action: "TeamDelete",
    inputs: { team_id: "exact team id", reason: "optional reason", dry_run: "optional boolean" },
    required: ["team_id"],
    notes: "Design-gated exact-id team deletion surface. Future implementation must be audited and permission-gated."
  },
  "schedule.create": {
    action: "schedule.create",
    inputs: { action: "schedule.create", cron: "5-field cron expression", prompt: "prompt to run", recurring: "optional boolean", durable: "optional boolean", timezone: "optional timezone", dry_run: "optional boolean" },
    required: ["cron", "prompt"],
    notes: "Design-gated automation surface. Returns recoverable unavailable guidance until Swarm has a durable scheduler daemon/store."
  },
  "schedule.list": {
    action: "schedule.list",
    inputs: { action: "schedule.list", status: "optional active | paused | expired", limit: "optional number" },
    notes: "Design-gated schedule inventory surface. It does not invent schedule state when no durable scheduler exists."
  },
  "schedule.delete": {
    action: "schedule.delete",
    inputs: { action: "schedule.delete", schedule_id: "exact schedule id", reason: "optional reason", dry_run: "optional boolean" },
    required: ["schedule_id"],
    notes: "Design-gated exact-id schedule deletion surface. Must be permission-gated if durable schedules are implemented later."
  },
  "remote.trigger": {
    action: "remote.trigger",
    inputs: { action: "remote.trigger", endpoint: "optional configured endpoint id", capability: "optional remote capability", payload: "optional JSON payload", dry_run: "optional boolean" },
    notes: "Design-gated remote integration boundary. Requires explicit configured endpoints and never uses implicit credentials."
  },
  "team.create": {
    action: "team.create",
    inputs: { action: "team.create", name: "optional team name", objective: "team objective", roles: "optional role list", task_ids: "optional existing task ids", dry_run: "optional boolean" },
    required: ["objective"],
    notes: "Design-gated team lifecycle surface. Future implementation must compose existing agent/task primitives instead of a second team store."
  },
  "team.delete": {
    action: "team.delete",
    inputs: { action: "team.delete", team_id: "exact team id", reason: "optional reason", dry_run: "optional boolean" },
    required: ["team_id"],
    notes: "Design-gated exact-id team deletion surface. Future implementation must be audited and permission-gated."
  },
  "task.create": {
    action: "task.create",
    inputs: { action: "task.create", title: "task title", objective: "optional objective", description: "optional details", task_id: "optional stable id", session_id: "optional session id", status: "optional task status", capability: "optional capability", required_capabilities: "optional string[]", file_scope: "optional string[]" },
    required: ["title"],
    notes: "Creates a tracked task in the current Swarm session using existing task state stores."
  },
  "task.update": {
    action: "task.update",
    inputs: { action: "task.update", task_id: "task id", session_id: "optional session id", status: "optional task status", summary: "optional progress/result summary", output: "optional output to persist", output_ref: "optional output ref", last_error: "optional error text", progress: "optional number" },
    required: ["task_id"]
  },
  "task.get": {
    action: "task.get",
    inputs: { action: "task.get", task_id: "task id", session_id: "optional session id" },
    required: ["task_id"]
  },
  "task.list": {
    action: "task.list",
    inputs: { action: "task.list", session_id: "optional session id", status: "optional task status", limit: "optional number", offset: "optional number" }
  },
  "task.output": {
    action: "task.output",
    inputs: { action: "task.output", task_id: "optional task id", worker_id: "optional worker id", session_id: "optional session id", output_ref: "optional persisted output path/ref", max_bytes: "optional byte budget", offset: "optional byte offset" },
    required_any: [["task_id", "worker_id", "output_ref"]]
  },
  "task.stop": {
    action: "task.stop",
    inputs: { action: "task.stop", task_id: "task or worker id to stop", session_id: "optional session id", reason: "optional cancellation reason" },
    required: ["task_id"]
  },
  "agent.delegate": {
    action: "agent.delegate",
    inputs: {
      action: "agent.delegate",
      capability: "requested capability such as code.research, code.review, verify, architecture.design, bug.fix",
      task: "bounded internal task for the specialist",
      context: "optional concise context and evidence",
      preferred_agent_spec_id: "optional agent spec id from available_agent_specs",
      preferred_mode: "optional call_subagent | handoff | parallel",
      run_in_background: "optional boolean; true maps to preferred_mode=parallel and returns immediately after launch",
      file_scope: "optional string[]; required for scoped_write implementation delegation"
    },
    required: ["capability", "task"]
  }
};

export function validateLocalToolActionInputs(action: ToolAction): string | undefined {
  return validateToolInputContract(action.type, action as unknown as Record<string, unknown>, LOCAL_TOOL_SCHEMAS[action.type]);
}

export function localToolSchemaForModel(schema: LocalToolSchema): LocalToolSchema & { input_schema: LocalToolInputSchema } {
  return {
    ...schema,
    input_schema: schema.input_schema ?? deriveLocalToolInputSchema(schema)
  };
}

export function deriveLocalToolInputSchema(schema: LocalToolSchema): LocalToolInputSchema {
  const properties = Object.fromEntries(
    Object.entries(schema.inputs).map(([name, description]) => [name, inferInputPropertySchema(name, description)])
  );
  const allOf = [
    ...requiredAnyClauses(schema.required_any),
    ...requiredWhenClauses(schema.required_when)
  ];
  return stripEmptySchemaFields({
    type: "object",
    properties,
    required: schema.required?.length ? schema.required : undefined,
    allOf: allOf.length ? allOf : undefined,
    additionalProperties: true
  });
}

function validateToolInputContract(action: string, values: Record<string, unknown>, schema: LocalToolSchema | undefined): string | undefined {
  if (!schema) {
    return undefined;
  }
  const missing = validateRequiredFields(values, schema.required);
  if (missing) {
    return missingToolInput(action, missing);
  }
  const missingGroup = validateRequiredAny(values, schema.required_any);
  if (missingGroup) {
    return missingToolInput(action, missingGroup.join(" or "));
  }
  for (const rule of schema.required_when ?? []) {
    if (!matchesRequiredWhen(values, rule.when)) {
      continue;
    }
    const missingConditional = validateRequiredFields(values, rule.required);
    if (missingConditional) {
      return missingToolInput(action, missingConditional);
    }
    const missingConditionalGroup = validateRequiredAny(values, rule.required_any);
    if (missingConditionalGroup) {
      return missingToolInput(action, missingConditionalGroup.join(" or "));
    }
  }
  return undefined;
}

function validateRequiredFields(values: Record<string, unknown>, fields: string[] | undefined): string | undefined {
  return fields?.find((field) => !hasToolInputValue(values[field]));
}

function validateRequiredAny(values: Record<string, unknown>, groups: string[][] | undefined): string[] | undefined {
  return groups?.find((group) => !group.some((field) => hasToolInputValue(values[field])));
}

function matchesRequiredWhen(values: Record<string, unknown>, when: Record<string, string | number | boolean | null>): boolean {
  return Object.entries(when).every(([field, expected]) => values[field] === expected);
}

function hasToolInputValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function missingToolInput(action: string, field: string): string {
  return `tool_call for ${action} is missing required input: ${field}.`;
}

function requiredAnyClauses(groups: string[][] | undefined): LocalToolInputSchemaClause[] {
  return (groups ?? []).map((group) => ({
    anyOf: group.map((field) => ({ required: [field] }))
  }));
}

function requiredWhenClauses(rules: LocalToolRequiredWhen[] | undefined): LocalToolInputSchemaClause[] {
  return (rules ?? []).map((rule) => stripEmptyClause({
    if: {
      properties: Object.fromEntries(Object.entries(rule.when).map(([field, expected]) => [field, { const: expected }])),
      required: Object.keys(rule.when)
    },
    then: stripEmptyThen({
      required: rule.required?.length ? rule.required : undefined,
      allOf: requiredAnyClauses(rule.required_any)
    })
  }));
}

function inferInputPropertySchema(name: string, description: unknown): LocalToolInputPropertySchema {
  const text = typeof description === "string" ? description : JSON.stringify(description);
  const lower = `${name} ${text}`.toLowerCase();
  const base: LocalToolInputPropertySchema = {
    description: text
  };
  if (lower.includes("string[]") || lower.includes("array of string") || lower.includes("string array")) {
    return { ...base, type: "array", items: { type: "string" } };
  }
  if (lower.includes("array") || lower.includes("todos") || lower.includes("hunks")) {
    return { ...base, type: "array", items: { type: "object", additionalProperties: true } };
  }
  if (lower.includes("boolean") || lower.includes("optional boolean") || name.startsWith("is")) {
    return { ...base, type: "boolean" };
  }
  if (lower.includes("number") || lower.includes("line") || lower.includes("limit") || lower.includes("bytes") || lower.includes("timeout") || lower.includes("max") || lower.includes("count")) {
    return { ...base, type: "number" };
  }
  if (lower.includes("json") || lower.includes("value")) {
    return { ...base };
  }
  const enumValues = enumValuesFromDescription(text);
  return enumValues.length ? { ...base, type: "string", enum: enumValues } : { ...base, type: "string" };
}

function enumValuesFromDescription(description: string): string[] {
  const match = description.match(/(?:^|\s)([a-zA-Z0-9_.-]+(?:\s*\|\s*[a-zA-Z0-9_.-]+)+)(?:\s|$)/);
  if (!match) {
    return [];
  }
  return match[1].split("|").map((item) => item.trim()).filter(Boolean);
}

function stripEmptySchemaFields(schema: LocalToolInputSchema): LocalToolInputSchema {
  if (!schema.required?.length) {
    delete schema.required;
  }
  if (!schema.allOf?.length) {
    delete schema.allOf;
  }
  return schema;
}

function stripEmptyClause(clause: LocalToolInputSchemaClause): LocalToolInputSchemaClause {
  if (clause.then && !clause.then.required?.length && !clause.then.allOf?.length) {
    delete clause.then;
  }
  return clause;
}

function stripEmptyThen(then: NonNullable<LocalToolInputSchemaClause["then"]>): NonNullable<LocalToolInputSchemaClause["then"]> {
  if (!then.required?.length) {
    delete then.required;
  }
  if (!then.allOf?.length) {
    delete then.allOf;
  }
  return then;
}
