import type { SwarmSettings } from "../config/settings.js";
import type { RiskClass } from "../protocol/types.js";

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
  line?: number;
  content?: string;
};

export type TodoWriteAction = {
  type: "todo.write";
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
};

export type ShellExecAction = {
  type: "shell.exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
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
  timeoutMs?: number;
  maxBytes?: number;
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

export type PackageInstallAction = {
  type: "package.install";
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type SolidityCompileAction = {
  type: "solidity.compile";
  cwd?: string;
  framework?: "solc" | "hardhat" | "foundry";
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
  | FileWriteAction
  | FileEditAction
  | TodoWriteAction
  | ShellExecAction
  | WebSearchAction
  | WebFetchAction
  | CodeTestAction
  | CodeLintAction
  | GitStatusAction
  | GitDiffAction
  | GitLogAction
  | GitBranchAction
  | PackageInstallAction
  | SolidityCompileAction
  | AgentDelegateAction;

export type LocalToolContext = {
  workspace: string;
  settings: SwarmSettings;
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  delegate?: (action: AgentDelegateAction) => Promise<ToolResult>;
  serverWebSearch?: (action: WebSearchAction) => Promise<ToolResult>;
  onWorkspaceChange?: (change: WorkspaceChangeMetadata) => void;
  onFileLock?: (event: FileLockEvent) => void;
};

export type WorkspaceChangeMetadata = {
  path: string;
  operation: "create" | "update" | "edit";
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
  action: ToolAction["type"];
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
