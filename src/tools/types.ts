import type { SwarmSettings } from "../config/settings.js";

export type FileReadAction = {
  type: "file.read";
  path?: string;
  paths?: string[];
  startLine?: number;
  endLine?: number;
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
};

export type ToolAction =
  | FileReadAction
  | FileListAction
  | FileGlobAction
  | FileGrepAction
  | FileStatAction
  | FileWriteAction
  | FileEditAction
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
  delegate?: (action: AgentDelegateAction) => Promise<ToolResult>;
};

export type ToolResult = {
  action: ToolAction["type"];
  summary: string;
  content?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

export type ToolApprovalRequest = {
  id: string;
  action: ToolAction["type"];
  summary: string;
  detail: string;
  risk: "write" | "shell" | "web" | "install" | "delegate";
};
