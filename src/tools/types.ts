import type { SwarmSettings } from "../config/settings.js";
import type { AgentAddress, BlackboardEntry, RiskClass } from "../protocol/types.js";

export type FileReadAction = {
  type: "file.read";
  path?: string;
  paths?: string[];
  startLine?: number;
  endLine?: number;
  offset?: number;
  limit?: number;
  maxBytes?: number;
};

export type FileListAction = {
  type: "file.list";
  root: string;
  maxFiles?: number;
  maxDepth?: number;
};

export type FileGlobAction = {
  type: "file.glob";
  root: string;
  pattern: string;
  maxResults?: number;
  maxDepth?: number;
};

export type FileGrepAction = {
  type: "file.grep";
  root: string;
  pattern: string;
  include?: string;
  maxMatches?: number;
  contextLines?: number;
};

export type FileStatAction = {
  type: "file.stat";
  path: string;
};

export type FileResolveAction = {
  type: "file.resolve";
  path: string;
};

export type FileWriteAction = {
  type: "file.write";
  path: string;
  content: string;
};

export type FileEditAction = {
  type: "file.edit";
  path: string;
  operation: "str_replace" | "insert";
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  line?: number;
  content?: string;
};

export type FileMkdirAction = {
  type: "file.mkdir";
  path: string;
  recursive?: boolean;
};

export type FileMoveAction = {
  type: "file.move";
  source: string;
  destination: string;
  overwrite?: boolean;
};

export type FileCopyAction = {
  type: "file.copy";
  source: string;
  destination: string;
  overwrite?: boolean;
  recursive?: boolean;
};

export type FileDeleteAction = {
  type: "file.delete";
  path: string;
  recursive?: boolean;
};

export type FilePatchAction = {
  type: "file.patch";
  path: string;
  hunks: Array<{
    oldText: string;
    newText: string;
  }>;
};

export type JsonReadAction = {
  type: "json.read";
  path: string;
  pointer?: string;
};

export type JsonEditAction = {
  type: "json.edit";
  path: string;
  operation: "set" | "delete" | "merge";
  pointer: string;
  value?: unknown;
};

export type TodoWriteAction = {
  type: "todo.write";
  todos: Array<{
    content: string;
    activeForm?: string;
    status: "pending" | "in_progress" | "completed";
  }>;
};

export type BlackboardWriteAction = {
  type: "blackboard.write";
  key: string;
  value: unknown;
  entryType: BlackboardEntry["type"];
  visibility?: BlackboardEntry["visibility"];
  tags?: string[];
  sessionId?: string;
  taskId?: string;
};

export type BlackboardReadAction = {
  type: "blackboard.read";
  entryId?: string;
  key?: string;
  sessionId?: string;
  limit?: number;
};

export type BlackboardSearchAction = {
  type: "blackboard.search";
  query?: string;
  entryType?: BlackboardEntry["type"];
  tag?: string;
  keyPrefix?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
};

export type BlackboardListAction = {
  type: "blackboard.list";
  entryType?: BlackboardEntry["type"];
  tag?: string;
  keyPrefix?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
};

export type ShellExecAction = {
  type: "shell.exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runInBackground?: boolean;
  description?: string;
  maxLogBytes?: number;
};

export type ExecAction = {
  type: "exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runInBackground?: boolean;
  description?: string;
  maxLogBytes?: number;
};

export type ProcessStartAction = {
  type: "process.start";
  command: string;
  cwd?: string;
  description?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
};

export type ProcessStatusAction = {
  type: "process.status";
  processId?: string;
  sessionId?: string;
};

export type ProcessListAction = {
  type: "process.list";
  sessionId?: string;
  status?: "running" | "completed" | "failed" | "stopped" | "unknown";
  limit?: number;
};

export type ProcessTailAction = {
  type: "process.tail";
  processId: string;
  sessionId?: string;
  lines?: number;
  maxBytes?: number;
};

export type ProcessGrepAction = {
  type: "process.grep";
  processId: string;
  sessionId?: string;
  pattern: string;
  maxMatches?: number;
  contextLines?: number;
};

export type ProcessStopAction = {
  type: "process.stop";
  processId: string;
  sessionId?: string;
};

export type WebSearchAction = {
  type: "web.search";
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  maxUses?: number;
};

export type WebFetchAction = {
  type: "web.fetch";
  url: string;
  prompt?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

export type NotebookEditAction = {
  type: "notebook.edit";
  notebookPath: string;
  cellId?: string;
  newSource?: string;
  cellType?: "code" | "markdown";
  editMode?: "replace" | "insert" | "delete";
};

export type CodeTestAction = {
  type: "code.test";
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type CodeLintAction = {
  type: "code.lint";
  root?: string;
  include?: string;
};

export type CodeBuildAction = {
  type: "code.build";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type GitStatusAction = {
  type: "git.status";
  cwd?: string;
};

export type GitDiffAction = {
  type: "git.diff";
  cwd?: string;
  staged?: boolean;
};

export type GitLogAction = {
  type: "git.log";
  cwd?: string;
  maxCommits?: number;
};

export type GitBranchAction = {
  type: "git.branch";
  cwd?: string;
  action?: "list" | "create" | "switch";
  name?: string;
};

export type GitShowAction = {
  type: "git.show";
  cwd?: string;
  revision?: string;
  path?: string;
  maxOutputBytes?: number;
};

export type PackageInstallAction = {
  type: "package.install";
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type PackageInfoAction = {
  type: "package.info";
  cwd?: string;
  manifest?: string;
};

export type ProjectDetectAction = {
  type: "project.detect";
  root?: string;
};

export type AgentDelegateAction = {
  type: "agent.delegate";
  capability: string;
  task: string;
  context?: string;
  preferred_agent_spec_id?: string;
  preferred_mode?: "call_subagent" | "handoff" | "parallel";
  file_scope?: string[];
};

export type ToolAction =
  | FileReadAction
  | FileListAction
  | FileGlobAction
  | FileGrepAction
  | FileStatAction
  | FileResolveAction
  | FileWriteAction
  | FileEditAction
  | FileMkdirAction
  | FileMoveAction
  | FileCopyAction
  | FileDeleteAction
  | FilePatchAction
  | JsonReadAction
  | JsonEditAction
  | TodoWriteAction
  | BlackboardWriteAction
  | BlackboardReadAction
  | BlackboardSearchAction
  | BlackboardListAction
  | ShellExecAction
  | ExecAction
  | ProcessStartAction
  | ProcessStatusAction
  | ProcessListAction
  | ProcessTailAction
  | ProcessGrepAction
  | ProcessStopAction
  | WebSearchAction
  | WebFetchAction
  | NotebookEditAction
  | CodeTestAction
  | CodeLintAction
  | CodeBuildAction
  | GitStatusAction
  | GitDiffAction
  | GitLogAction
  | GitBranchAction
  | GitShowAction
  | PackageInstallAction
  | PackageInfoAction
  | ProjectDetectAction
  | AgentDelegateAction;

export type LocalToolContext = {
  workspace: string;
  settings: SwarmSettings;
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  delegate?: (action: AgentDelegateAction) => Promise<ToolResult>;
  serverWebSearch?: (action: WebSearchAction) => Promise<ToolResult>;
  blackboard?: {
    write: (action: BlackboardWriteAction, context: BlackboardToolContext) => Promise<BlackboardEntry> | BlackboardEntry;
    read: (action: BlackboardReadAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]> | BlackboardEntry[];
    search: (action: BlackboardSearchAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]> | BlackboardEntry[];
    list: (action: BlackboardListAction, context: BlackboardToolContext) => Promise<BlackboardEntry[]> | BlackboardEntry[];
  };
  blackboardSessionId?: string;
  agent?: AgentAddress;
  onWorkspaceChange?: (change: WorkspaceChangeMetadata) => void;
  onFileLock?: (event: FileLockEvent) => void;
};

export type BlackboardToolContext = {
  sessionId?: string;
  blackboardSessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: AgentAddress;
};

export type WorkspaceChangeMetadata = {
  path: string;
  operation: "create" | "update" | "edit" | "mkdir" | "move" | "copy" | "delete";
  beforeHash?: string;
  afterHash: string;
  beforeBytes: number;
  afterBytes: number;
  sessionId?: string;
  taskId?: string;
  lockKey?: string;
};

export type FileLockEvent = {
  key: string;
  path: string;
  status: "acquired" | "released" | "blocked";
  holder?: string;
  sessionId?: string;
  taskId?: string;
  reason?: string;
};

export type ToolResult = {
  action: ToolAction["type"] | string;
  status?: "success" | "partial" | "failed";
  summary: string;
  content?: string;
  outputRef?: string;
  errors?: string[];
  errorCode?: string;
  retryable?: boolean;
  recoverable?: boolean;
  recoverySuggestion?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

export type ToolApprovalRequest = {
  id: string;
  session_id?: string;
  task_id?: string;
  action: ToolAction["type"] | string;
  summary: string;
  detail: string;
  risk: "write" | "shell" | "web" | "install" | "delegate";
  risk_class: RiskClass;
  target: string;
  why_now: string;
  predicted_impact: string;
  rollback_plan: string;
  summary_diff?: string;
};
