import type { SwarmSettings } from "../config/settings.js";
import type { RecoveryAdvice } from "../runtime/recovery.js";
import type { ApprovalGovernanceEvidence } from "../runtime/safety-governance.js";
import type {
  LspCodeActionsAction,
  LspCompletionAction,
  LspDefinitionAction,
  LspDiagnosticsAction,
  LspDocumentSymbolsAction,
  LspFormatAction,
  LspHoverAction,
  LspReferencesAction,
  LspRenamePreviewAction,
  LspWorkspaceSymbolsAction
} from "../lsp/types.js";
import type { AgentAddress, BlackboardEntry, RiskClass, SwarmTask } from "../protocol/types.js";

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
  outputMode?: "content" | "files_with_matches" | "count";
  maxMatches?: number;
  headLimit?: number;
  offset?: number;
  contextLines?: number;
  beforeContext?: number;
  afterContext?: number;
  caseInsensitive?: boolean;
  multiline?: boolean;
  fileType?: string;
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

export type AskUserQuestionAction = {
  type: "ask_user_question";
  prompt: string;
  questions?: Array<{
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
      preview?: string;
    }>;
    multiSelect?: boolean;
  }>;
  choices?: Array<{
    label: string;
    description?: string;
    preview?: string;
  }>;
  defaultChoice?: string;
  recommendedChoice?: string;
  allowFreeform?: boolean;
  reason?: string;
};

export type PlanEnterAction = {
  type: "plan.enter";
  objective?: string;
  reason?: string;
};

export type PlanExitAction = {
  type: "plan.exit";
  plan: string;
  summary?: string;
  ready?: boolean;
  allowedPrompts?: Array<{
    tool: string;
    prompt: string;
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

export type PowerShellExecAction = {
  type: "powershell.exec";
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

export type ConfigGetAction = {
  type: "config.get";
  setting?: string;
};

export type ConfigSetAction = {
  type: "config.set";
  setting: string;
  value: string | number | boolean | null;
};

export type McpResourcesAction = {
  type: "mcp.resources";
  server?: string;
  limit?: number;
};

export type McpReadAction = {
  type: "mcp.read";
  server: string;
  uri: string;
  maxBytes?: number;
};

export type McpAuthAction = {
  type: "mcp.auth";
  server?: string;
};

export type McpCallAction = {
  type: "mcp.call";
  server?: string;
  tool?: string;
  capabilityId?: string;
  args?: Record<string, unknown>;
  maxBytes?: number;
};

export type SkillInvokeAction = {
  type: "skill.invoke";
  name: string;
  reason?: string;
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
  run_in_background?: boolean;
  file_scope?: string[];
};

export type AgentListAction = {
  type: "agent.list";
  parent_session_id?: string;
  status?: "pending" | "running" | "completed" | "failed" | "stopped";
  limit?: number;
};

export type AgentStatusAction = {
  type: "agent.status";
  worker_id: string;
};

export type AgentStopAction = {
  type: "agent.stop";
  worker_id: string;
};

export type AgentContinueAction = {
  type: "agent.continue";
  worker_id: string;
  message: string;
  run_in_background?: boolean;
};

export type AgentMessageAction = {
  type: "agent.message";
  message: string;
  worker_id?: string;
  agent_id?: string;
  role?: string;
  capability?: string;
  session_id?: string;
  task_id?: string;
  require_ack?: boolean;
  ttl_ms?: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeSleepAction = {
  type: "runtime.sleep";
  duration_ms: number;
  reason?: string;
};

export type StructuredOutputAction = {
  type: "structured.output";
  value: unknown;
  schema?: Record<string, unknown>;
  label?: string;
  final?: boolean;
  session_id?: string;
  task_id?: string;
};

export type ReplModeAction = {
  type: "repl.mode";
  mode?: "interactive" | "headless" | "repl";
  reason?: string;
};

export type ScheduleCreateAction = {
  type: "schedule.create";
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  timezone?: string;
  dry_run?: boolean;
};

export type ScheduleListAction = {
  type: "schedule.list";
  status?: "active" | "paused" | "expired";
  limit?: number;
};

export type ScheduleDeleteAction = {
  type: "schedule.delete";
  schedule_id: string;
  reason?: string;
  dry_run?: boolean;
};

export type RemoteTriggerAction = {
  type: "remote.trigger";
  endpoint?: string;
  capability?: string;
  payload?: Record<string, unknown>;
  dry_run?: boolean;
};

export type TeamCreateAction = {
  type: "team.create";
  name?: string;
  objective: string;
  roles?: string[];
  task_ids?: string[];
  dry_run?: boolean;
};

export type TeamDeleteAction = {
  type: "team.delete";
  team_id: string;
  reason?: string;
  dry_run?: boolean;
};

export type TaskCreateAction = {
  type: "task.create";
  session_id?: string;
  task_id?: string;
  title: string;
  description?: string;
  objective?: string;
  taskType?: SwarmTask["type"];
  status?: SwarmTask["status"];
  required_capabilities?: string[];
  capability?: string;
  dependencies?: string[];
  parent_task_id?: string;
  assigned_to?: AgentAddress;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  file_scope?: string[];
};

export type TaskUpdateAction = {
  type: "task.update";
  session_id?: string;
  task_id: string;
  title?: string;
  status?: SwarmTask["status"];
  summary?: string;
  last_error?: string;
  attempt?: number;
  output?: string;
  output_ref?: string;
  progress?: number;
  metadata?: Record<string, unknown>;
};

export type TaskGetAction = {
  type: "task.get";
  session_id?: string;
  task_id: string;
};

export type TaskListAction = {
  type: "task.list";
  session_id?: string;
  status?: SwarmTask["status"];
  limit?: number;
  offset?: number;
};

export type TaskOutputAction = {
  type: "task.output";
  session_id?: string;
  task_id?: string;
  worker_id?: string;
  artifact_id?: string;
  output_ref?: string;
  max_bytes?: number;
  offset?: number;
};

export type TaskStopAction = {
  type: "task.stop";
  session_id?: string;
  task_id: string;
  reason?: string;
};

export type WorktreeEnterAction = {
  type: "worktree.enter";
  session_id?: string;
  path?: string;
  scope?: string[];
  branch?: string;
  name?: string;
  reason?: string;
  dry_run?: boolean;
};

export type WorktreeExitAction = {
  type: "worktree.exit";
  session_id?: string;
  lease_id?: string;
  mode?: "keep" | "remove";
  discardChanges?: boolean;
  reason?: string;
  dry_run?: boolean;
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
  | AskUserQuestionAction
  | PlanEnterAction
  | PlanExitAction
  | WorktreeEnterAction
  | WorktreeExitAction
  | BlackboardWriteAction
  | BlackboardReadAction
  | BlackboardSearchAction
  | BlackboardListAction
  | ShellExecAction
  | PowerShellExecAction
  | ExecAction
  | ProcessStartAction
  | ProcessStatusAction
  | ProcessListAction
  | ProcessTailAction
  | ProcessGrepAction
  | ProcessStopAction
  | WebSearchAction
  | WebFetchAction
  | ConfigGetAction
  | ConfigSetAction
  | McpResourcesAction
  | McpReadAction
  | McpAuthAction
  | McpCallAction
  | SkillInvokeAction
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
  | LspDiagnosticsAction
  | LspHoverAction
  | LspDefinitionAction
  | LspReferencesAction
  | LspDocumentSymbolsAction
  | LspWorkspaceSymbolsAction
  | LspCompletionAction
  | LspCodeActionsAction
  | LspRenamePreviewAction
  | LspFormatAction
  | AgentDelegateAction
  | AgentListAction
  | AgentStatusAction
  | AgentStopAction
  | AgentContinueAction
  | AgentMessageAction
  | RuntimeSleepAction
  | StructuredOutputAction
  | ReplModeAction
  | ScheduleCreateAction
  | ScheduleListAction
  | ScheduleDeleteAction
  | RemoteTriggerAction
  | TeamCreateAction
  | TeamDeleteAction
  | TaskCreateAction
  | TaskUpdateAction
  | TaskGetAction
  | TaskListAction
  | TaskOutputAction
  | TaskStopAction
  | WorktreeEnterAction
  | WorktreeExitAction;

export type LocalToolContext = {
  workspace: string;
  settings: SwarmSettings;
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  delegate?: (action: AgentDelegateAction) => Promise<ToolResult>;
  agentControl?: {
    list: (action: AgentListAction, context: AgentControlToolContext) => Promise<ToolResult> | ToolResult;
    status: (action: AgentStatusAction, context: AgentControlToolContext) => Promise<ToolResult> | ToolResult;
    stop: (action: AgentStopAction, context: AgentControlToolContext) => Promise<ToolResult> | ToolResult;
    continue: (action: AgentContinueAction, context: AgentControlToolContext) => Promise<ToolResult> | ToolResult;
  };
  taskControl?: {
    create: (action: TaskCreateAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
    update: (action: TaskUpdateAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
    get: (action: TaskGetAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
    list: (action: TaskListAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
    output: (action: TaskOutputAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
    stop: (action: TaskStopAction, context: TaskControlToolContext) => Promise<ToolResult> | ToolResult;
  };
  worktreeControl?: {
    enter: (action: WorktreeEnterAction, context: WorktreeControlToolContext) => Promise<ToolResult> | ToolResult;
    exit: (action: WorktreeExitAction, context: WorktreeControlToolContext) => Promise<ToolResult> | ToolResult;
  };
  runtimeControl?: {
    structuredOutputEnabled?: boolean;
    sendAgentMessage?: (action: AgentMessageAction, context: RuntimeControlToolContext) => Promise<ToolResult> | ToolResult;
    recordStructuredOutput?: (action: StructuredOutputAction, context: RuntimeControlToolContext) => Promise<ToolResult> | ToolResult;
    replMode?: (action: ReplModeAction, context: RuntimeControlToolContext) => Promise<ToolResult> | ToolResult;
  };
  externalContext?: {
    listMcpServers: () => Array<{
      id: string;
      status: string;
      transport?: string;
      trust?: string;
      exposeResources?: boolean;
      exposeTools?: boolean;
      toolCount?: number;
      resourceCount?: number;
      lastError?: string;
    }>;
    refreshMcpServer?: (serverId: string) => Promise<unknown> | unknown;
    listMcpResources: (serverId: string) => unknown[];
    readMcpResource: (input: { serverId: string; uri: string; sessionId?: string; taskId?: string; maxBytes?: number }) => Promise<ToolResult> | ToolResult;
    callMcpTool: (input: { serverId?: string; tool?: string; capabilityId?: string; args?: Record<string, unknown>; sessionId?: string; taskId?: string; maxBytes?: number }) => Promise<ToolResult> | ToolResult;
    listSkills: () => Array<{
      name: string;
      displayName?: string;
      description?: string;
      scope?: string;
      trust?: string;
      path?: string;
      allowedTools?: string[];
      resourcePaths?: string[];
      shadowedBy?: string;
    }>;
    invokeSkill: (input: { name: string; reason?: string; sessionId?: string; taskId?: string }) => Promise<ToolResult> | ToolResult;
  };
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

export type AgentControlToolContext = {
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: AgentAddress;
};

export type TaskControlToolContext = AgentControlToolContext;

export type WorktreeControlToolContext = AgentControlToolContext & {
  workspace: string;
};

export type RuntimeControlToolContext = AgentControlToolContext & {
  workspace: string;
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
  recovery?: RecoveryAdvice;
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
  permission_decision?: "allow" | "ask" | "deny";
  permission_reason?: string;
  permission_mode?: string;
  permission_name?: string;
  permission_rule?: string;
  attention_note?: string;
  summary_diff?: string;
  governance?: ApprovalGovernanceEvidence;
};
