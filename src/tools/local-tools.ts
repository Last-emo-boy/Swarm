import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  getBackgroundProcess,
  grepBackgroundProcessLog,
  listBackgroundProcesses,
  readBackgroundProcessTail,
  startBackgroundProcess,
  stopBackgroundProcess
} from "./background-processes.js";
import {
  assertToolAllowedByPermissions,
  assertReadableByDenyRules,
  displayPath,
  resolveReadablePath,
  resolveShellCwd,
  resolveWritablePath
} from "./permissions.js";
import { interpretCommandResult } from "./command-safety.js";
import {
  loadSwarmSettings,
  saveSwarmSettings,
  type SwarmSettings
} from "../config/settings.js";
import { ensureWorkspaceIndex } from "../runtime/workspace-index.js";
import type { LocalToolContext, ToolAction, ToolResult, WorkspaceChangeMetadata } from "./types.js";
import {
  GREP_FALLBACK_MAX_DEPTH,
  GREP_FALLBACK_MAX_FILES,
  grepLocalFilesWithRipgrep,
  type GrepMatch,
  type ShellCommandResult
} from "./file-grep.js";
import { runLspTool } from "../lsp/tools.js";
import { writeTaskOutput } from "../storage/task-output-store.js";

const AGENT_TOOL_DEFAULT_CAPABILITY = "code.research";

type WalkedFile = {
  path: string;
  display: string;
};

type ReadSnapshot = {
  mtimeMs: number;
  hash: string;
  fullView: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
};

const readSnapshots = new Map<string, ReadSnapshot>();
const todoStates = new Map<string, Array<{ content: string; activeForm?: string; status: "pending" | "in_progress" | "completed" }>>();
const writeLocks = new Map<string, { holder: string; acquiredAt: string }>();

export function normalizeToolAction(inputs: Record<string, unknown>, capability?: string): ToolAction {
  const rawAction = String(inputs.action ?? capability ?? "").trim();
  const action = isRunCommandAlias(rawAction)
    ? runCommandAliasTarget(inputs.command)
    : normalizeActionName(rawAction, inputs);
  const isVisibleAgentAction = rawAction === "Agent" || rawAction === "Task";
  if (action === "file.read") {
    return {
      type: "file.read",
      path: optionalStringInput(inputs.file_path ?? inputs.filePath ?? inputs.path),
      paths: stringArrayInput(inputs.paths),
      startLine: numberInput(inputs.startLine ?? inputs.start_line ?? inputs.start),
      endLine: numberInput(inputs.endLine ?? inputs.end_line ?? inputs.end),
      offset: numberInput(inputs.offset),
      limit: numberInput(inputs.limit),
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes)
    };
  }
  if (action === "file.list") {
    return {
      type: "file.list",
      root: stringInput(inputs.root || inputs.path || "."),
      maxFiles: numberInput(inputs.maxFiles ?? inputs.max_files),
      maxDepth: numberInput(inputs.maxDepth ?? inputs.max_depth)
    };
  }
  if (action === "file.glob") {
    return {
      type: "file.glob",
      root: stringInput(inputs.root || inputs.path || "."),
      pattern: stringInput(inputs.pattern || inputs.glob || "**/*"),
      maxResults: numberInput(inputs.maxResults ?? inputs.max_results),
      maxDepth: numberInput(inputs.maxDepth ?? inputs.max_depth)
    };
  }
  if (action === "file.grep") {
    return {
      type: "file.grep",
      root: stringInput(inputs.root || inputs.path || "."),
      pattern: stringInput(inputs.pattern || inputs.query),
      include: optionalStringInput(inputs.include ?? inputs.glob),
      outputMode: grepOutputModeInput(inputs.outputMode ?? inputs.output_mode),
      maxMatches: numberInput(inputs.maxMatches ?? inputs.max_matches),
      headLimit: numberInput(inputs.headLimit ?? inputs.head_limit),
      offset: numberInput(inputs.offset),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines ?? inputs.context ?? inputs["-C"]),
      beforeContext: numberInput(inputs.beforeContext ?? inputs.before_context ?? inputs["-B"]),
      afterContext: numberInput(inputs.afterContext ?? inputs.after_context ?? inputs["-A"]),
      caseInsensitive: booleanInput(inputs.caseInsensitive ?? inputs.case_insensitive ?? inputs["-i"]),
      multiline: booleanInput(inputs.multiline),
      fileType: optionalStringInput(inputs.fileType ?? inputs.file_type ?? inputs.type)
    };
  }
  if (action === "file.stat") {
    return { type: "file.stat", path: stringInput(inputs.path) };
  }
  if (action === "file.resolve") {
    return { type: "file.resolve", path: requiredStringInput(inputs.path, "file.resolve requires path") };
  }
  if (action === "file.write") {
    return { type: "file.write", path: requiredStringInput(inputs.file_path ?? inputs.filePath ?? inputs.path, "file.write requires path"), content: stringInput(inputs.content) };
  }
  if (action === "file.edit") {
    return {
      type: "file.edit",
      path: requiredStringInput(inputs.file_path ?? inputs.filePath ?? inputs.path, "file.edit requires path"),
      operation: String(inputs.operation ?? inputs.command ?? "str_replace") === "insert" ? "insert" : "str_replace",
      oldText: optionalStringInput(inputs.old_string ?? inputs.oldText ?? inputs.old_text ?? inputs.oldString ?? inputs.old_string),
      newText: optionalStringInput(inputs.new_string ?? inputs.newText ?? inputs.new_text ?? inputs.newString ?? inputs.new_string),
      replaceAll: inputs.replaceAll === true || inputs.replace_all === true || inputs.replaceAll === "true" || inputs.replace_all === "true",
      line: numberInput(inputs.line ?? inputs.insertLine ?? inputs.insert_line),
      content: optionalStringInput(inputs.content ?? inputs.insertText ?? inputs.insert_text)
    };
  }
  if (action === "file.mkdir") {
    return {
      type: "file.mkdir",
      path: requiredStringInput(inputs.path, "file.mkdir requires path"),
      recursive: inputs.recursive !== false && inputs.recursive !== "false"
    };
  }
  if (action === "file.move") {
    return {
      type: "file.move",
      source: requiredStringInput(inputs.source ?? inputs.from ?? inputs.src, "file.move requires source"),
      destination: requiredStringInput(inputs.destination ?? inputs.to ?? inputs.dest, "file.move requires destination"),
      overwrite: inputs.overwrite === true || inputs.overwrite === "true"
    };
  }
  if (action === "file.copy") {
    return {
      type: "file.copy",
      source: requiredStringInput(inputs.source ?? inputs.from ?? inputs.src, "file.copy requires source"),
      destination: requiredStringInput(inputs.destination ?? inputs.to ?? inputs.dest, "file.copy requires destination"),
      overwrite: inputs.overwrite === true || inputs.overwrite === "true",
      recursive: inputs.recursive === true || inputs.recursive === "true"
    };
  }
  if (action === "file.delete") {
    return {
      type: "file.delete",
      path: requiredStringInput(inputs.path, "file.delete requires path"),
      recursive: inputs.recursive === true || inputs.recursive === "true"
    };
  }
  if (action === "file.patch") {
    return {
      type: "file.patch",
      path: requiredStringInput(inputs.path, "file.patch requires path"),
      hunks: patchHunksInput(inputs.hunks ?? inputs.replacements ?? inputs.patch)
    };
  }
  if (action === "json.read") {
    return {
      type: "json.read",
      path: requiredStringInput(inputs.path, "json.read requires path"),
      pointer: optionalStringInput(inputs.pointer ?? inputs.jsonPointer ?? inputs.json_pointer)
    };
  }
  if (action === "json.edit") {
    return {
      type: "json.edit",
      path: requiredStringInput(inputs.path, "json.edit requires path"),
      operation: jsonEditOperationInput(inputs.operation ?? inputs.command),
      pointer: requiredStringInput(inputs.pointer ?? inputs.jsonPointer ?? inputs.json_pointer, "json.edit requires pointer"),
      value: inputs.value
    };
  }
  if (action === "todo.write") {
    return {
      type: "todo.write",
      todos: todoListInput(inputs.todos)
    };
  }
  if (action === "ask_user_question") {
    return {
      type: "ask_user_question",
      prompt: requiredStringInput(inputs.prompt ?? inputs.question ?? firstQuestionText(inputs.questions), "ask_user_question requires prompt"),
      questions: structuredQuestionsInput(inputs.questions),
      choices: questionChoicesInput(inputs.choices ?? inputs.options),
      defaultChoice: optionalStringInput(inputs.defaultChoice ?? inputs.default_choice),
      recommendedChoice: optionalStringInput(inputs.recommendedChoice ?? inputs.recommended_choice),
      allowFreeform: booleanInput(inputs.allowFreeform ?? inputs.allow_freeform),
      reason: optionalStringInput(inputs.reason)
    };
  }
  if (action === "plan.enter") {
    return {
      type: "plan.enter",
      objective: optionalStringInput(inputs.objective ?? inputs.task ?? inputs.prompt),
      reason: optionalStringInput(inputs.reason)
    };
  }
  if (action === "plan.exit") {
    return {
      type: "plan.exit",
      plan: requiredStringInput(inputs.plan ?? inputs.content ?? inputs.summary, "plan.exit requires plan"),
      summary: optionalStringInput(inputs.summary),
      ready: booleanInput(inputs.ready),
      allowedPrompts: allowedPromptsInput(inputs.allowedPrompts ?? inputs.allowed_prompts)
    };
  }
  if (action === "worktree.enter") {
    return {
      type: "worktree.enter",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      path: optionalStringInput(inputs.path ?? inputs.worktree_path ?? inputs.worktreePath),
      scope: stringArrayInput(inputs.scope ?? inputs.file_scope ?? inputs.fileScope ?? inputs.paths),
      branch: optionalStringInput(inputs.branch ?? inputs.worktree_branch ?? inputs.worktreeBranch),
      name: optionalStringInput(inputs.name ?? inputs.slug ?? inputs.worktree_name ?? inputs.worktreeName),
      reason: optionalStringInput(inputs.reason ?? inputs.message),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun ?? inputs.preview)
    };
  }
  if (action === "worktree.exit") {
    return {
      type: "worktree.exit",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      lease_id: optionalStringInput(inputs.lease_id ?? inputs.leaseId),
      mode: worktreeExitModeInput(inputs.mode ?? inputs.exit_mode ?? inputs.exitMode ?? inputs.worktree_action ?? inputs.worktreeAction),
      discardChanges: booleanInput(inputs.discardChanges ?? inputs.discard_changes),
      reason: optionalStringInput(inputs.reason ?? inputs.message),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun ?? inputs.preview)
    };
  }
  if (action === "blackboard.write") {
    return {
      type: "blackboard.write",
      key: requiredStringInput(inputs.key, "Saving a shared fact requires key"),
      value: inputs.value ?? inputs.content,
      entryType: blackboardEntryTypeInput(inputs.entryType ?? inputs.entry_type ?? inputs.type),
      visibility: blackboardVisibilityInput(inputs.visibility),
      tags: stringListInput(inputs.tags),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      taskId: optionalStringInput(inputs.taskId ?? inputs.task_id)
    };
  }
  if (action === "blackboard.read") {
    const entryId = optionalStringInput(inputs.entryId ?? inputs.entry_id);
    const key = optionalStringInput(inputs.key);
    if (!entryId && !key) {
      throw new Error("Reading a shared fact requires entry_id or key");
    }
    return {
      type: "blackboard.read",
      entryId,
      key,
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "blackboard.search") {
    return {
      type: "blackboard.search",
      query: optionalStringInput(inputs.query),
      entryType: optionalBlackboardEntryTypeInput(inputs.entryType ?? inputs.entry_type ?? inputs.type),
      tag: optionalStringInput(inputs.tag),
      keyPrefix: optionalStringInput(inputs.keyPrefix ?? inputs.key_prefix),
      taskId: optionalStringInput(inputs.taskId ?? inputs.task_id),
      agentId: optionalStringInput(inputs.agentId ?? inputs.agent_id),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "blackboard.list") {
    return {
      type: "blackboard.list",
      entryType: optionalBlackboardEntryTypeInput(inputs.entryType ?? inputs.entry_type ?? inputs.type),
      tag: optionalStringInput(inputs.tag),
      keyPrefix: optionalStringInput(inputs.keyPrefix ?? inputs.key_prefix),
      taskId: optionalStringInput(inputs.taskId ?? inputs.task_id),
      agentId: optionalStringInput(inputs.agentId ?? inputs.agent_id),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "shell.exec") {
    return {
      type: "shell.exec",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes),
      runInBackground: booleanInput(inputs.runInBackground ?? inputs.run_in_background ?? inputs.background),
      description: optionalStringInput(inputs.description),
      maxLogBytes: numberInput(inputs.maxLogBytes ?? inputs.max_log_bytes)
    };
  }
  if (action === "powershell.exec") {
    return {
      type: "powershell.exec",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes),
      runInBackground: booleanInput(inputs.runInBackground ?? inputs.run_in_background ?? inputs.background),
      description: optionalStringInput(inputs.description),
      maxLogBytes: numberInput(inputs.maxLogBytes ?? inputs.max_log_bytes)
    };
  }
  if (action === "exec") {
    return {
      type: "exec",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes),
      runInBackground: booleanInput(inputs.runInBackground ?? inputs.run_in_background ?? inputs.background),
      description: optionalStringInput(inputs.description),
      maxLogBytes: numberInput(inputs.maxLogBytes ?? inputs.max_log_bytes)
    };
  }
  if (action === "process.start") {
    return {
      type: "process.start",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      description: optionalStringInput(inputs.description),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
      maxLogBytes: numberInput(inputs.maxLogBytes ?? inputs.max_log_bytes)
    };
  }
  if (action === "process.status") {
    return {
      type: "process.status",
      processId: optionalStringInput(inputs.processId ?? inputs.process_id ?? inputs.id),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id)
    };
  }
  if (action === "process.list") {
    return {
      type: "process.list",
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      status: processStatusInput(inputs.status),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "process.tail") {
    return {
      type: "process.tail",
      processId: requiredStringInput(inputs.processId ?? inputs.process_id ?? inputs.id, "process.tail requires processId"),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      lines: numberInput(inputs.lines ?? inputs.limit),
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes)
    };
  }
  if (action === "process.grep") {
    return {
      type: "process.grep",
      processId: requiredStringInput(inputs.processId ?? inputs.process_id ?? inputs.id, "process.grep requires processId"),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id),
      pattern: requiredStringInput(inputs.pattern ?? inputs.query, "process.grep requires pattern"),
      maxMatches: numberInput(inputs.maxMatches ?? inputs.max_matches ?? inputs.head_limit),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines ?? inputs.context)
    };
  }
  if (action === "process.stop") {
    return {
      type: "process.stop",
      processId: requiredStringInput(inputs.processId ?? inputs.process_id ?? inputs.id, "process.stop requires processId"),
      sessionId: optionalStringInput(inputs.sessionId ?? inputs.session_id)
    };
  }
  if (action === "web.search") {
    return {
      type: "web.search",
      query: stringInput(inputs.query),
      allowed_domains: stringListInput(inputs.allowed_domains ?? inputs.allowedDomains ?? inputs.allowDomains),
      blocked_domains: stringListInput(inputs.blocked_domains ?? inputs.blockedDomains ?? inputs.blockDomains),
      maxUses: numberInput(inputs.maxUses ?? inputs.max_uses)
    };
  }
  if (action === "web.fetch") {
    return {
      type: "web.fetch",
      url: stringInput(inputs.url),
      prompt: optionalStringInput(inputs.prompt),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms),
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes)
    };
  }
  if (action === "config.get") {
    return {
      type: "config.get",
      setting: optionalStringInput(inputs.setting ?? inputs.key)
    };
  }
  if (action === "config.set") {
    return {
      type: "config.set",
      setting: requiredStringInput(inputs.setting ?? inputs.key, "config.set requires setting"),
      value: configValueInput(inputs.value)
    };
  }
  if (action === "mcp.resources") {
    return {
      type: "mcp.resources",
      server: optionalStringInput(inputs.server ?? inputs.server_id ?? inputs.serverId),
      limit: numberInput(inputs.limit ?? inputs.max_results ?? inputs.maxResults)
    };
  }
  if (action === "mcp.read") {
    return {
      type: "mcp.read",
      server: requiredStringInput(inputs.server ?? inputs.server_id ?? inputs.serverId, "mcp.read requires server"),
      uri: requiredStringInput(inputs.uri, "mcp.read requires uri"),
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes ?? inputs.limit)
    };
  }
  if (action === "mcp.auth") {
    return {
      type: "mcp.auth",
      server: optionalStringInput(inputs.server ?? inputs.server_id ?? inputs.serverId)
    };
  }
  if (action === "mcp.call") {
    return {
      type: "mcp.call",
      server: optionalStringInput(inputs.server ?? inputs.server_id ?? inputs.serverId),
      tool: optionalStringInput(inputs.tool ?? inputs.tool_name ?? inputs.toolName ?? inputs.name),
      capabilityId: optionalStringInput(inputs.capabilityId ?? inputs.capability_id),
      args: recordInput(inputs.args ?? inputs.arguments) ?? {},
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes ?? inputs.limit)
    };
  }
  if (action === "skill.invoke") {
    return {
      type: "skill.invoke",
      name: requiredStringInput(inputs.name ?? inputs.skill ?? inputs.skill_name ?? inputs.skillName, "skill.invoke requires name"),
      reason: optionalStringInput(inputs.reason)
    };
  }
  if (action === "agent.message") {
    return {
      type: "agent.message",
      worker_id: optionalStringInput(inputs.worker_id ?? inputs.workerId),
      agent_id: optionalStringInput(inputs.agent_id ?? inputs.agentId),
      role: optionalStringInput(inputs.role),
      capability: optionalStringInput(inputs.capability),
      message: requiredStringInput(inputs.message ?? inputs.content ?? inputs.text, "agent.message requires message"),
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: optionalStringInput(inputs.task_id ?? inputs.taskId),
      require_ack: booleanInput(inputs.require_ack ?? inputs.requireAck),
      ttl_ms: numberInput(inputs.ttl_ms ?? inputs.ttlMs ?? inputs.timeoutMs),
      metadata: recordInput(inputs.metadata)
    };
  }
  if (action === "runtime.sleep") {
    return {
      type: "runtime.sleep",
      duration_ms: requiredNumberInput(inputs.duration_ms ?? inputs.durationMs ?? inputs.ms ?? inputs.sleep_ms ?? inputs.sleepMs, "runtime.sleep requires duration_ms"),
      reason: optionalStringInput(inputs.reason)
    };
  }
  if (action === "structured.output") {
    return {
      type: "structured.output",
      value: inputs.value ?? inputs.output ?? inputs.result,
      schema: recordInput(inputs.schema ?? inputs.json_schema ?? inputs.jsonSchema),
      label: optionalStringInput(inputs.label ?? inputs.name),
      final: booleanInput(inputs.final),
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: optionalStringInput(inputs.task_id ?? inputs.taskId)
    };
  }
  if (action === "repl.mode") {
    const mode = optionalStringInput(inputs.mode);
    return {
      type: "repl.mode",
      mode: mode === "interactive" || mode === "headless" || mode === "repl" ? mode : undefined,
      reason: optionalStringInput(inputs.reason)
    };
  }
  if (action === "schedule.create") {
    return {
      type: "schedule.create",
      cron: requiredStringInput(inputs.cron ?? inputs.schedule, "schedule.create requires cron"),
      prompt: requiredStringInput(inputs.prompt ?? inputs.task ?? inputs.message, "schedule.create requires prompt"),
      recurring: booleanInput(inputs.recurring),
      durable: booleanInput(inputs.durable),
      timezone: optionalStringInput(inputs.timezone ?? inputs.time_zone),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun)
    };
  }
  if (action === "schedule.list") {
    return {
      type: "schedule.list",
      status: scheduleStatusInput(inputs.status),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "schedule.delete") {
    return {
      type: "schedule.delete",
      schedule_id: requiredStringInput(inputs.schedule_id ?? inputs.scheduleId ?? inputs.id, "schedule.delete requires schedule_id"),
      reason: optionalStringInput(inputs.reason),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun)
    };
  }
  if (action === "remote.trigger") {
    return {
      type: "remote.trigger",
      endpoint: optionalStringInput(inputs.endpoint ?? inputs.endpoint_id ?? inputs.endpointId ?? inputs.remote),
      capability: optionalStringInput(inputs.capability ?? inputs.tool),
      payload: recordInput(inputs.payload ?? inputs.args),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun)
    };
  }
  if (action === "team.create") {
    return {
      type: "team.create",
      name: optionalStringInput(inputs.name ?? inputs.team_name ?? inputs.teamName),
      objective: requiredStringInput(inputs.objective ?? inputs.prompt ?? inputs.description, "team.create requires objective"),
      roles: stringListInput(inputs.roles),
      task_ids: stringArrayInput(inputs.task_ids ?? inputs.taskIds),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun)
    };
  }
  if (action === "team.delete") {
    return {
      type: "team.delete",
      team_id: requiredStringInput(inputs.team_id ?? inputs.teamId ?? inputs.id, "team.delete requires team_id"),
      reason: optionalStringInput(inputs.reason),
      dry_run: booleanInput(inputs.dry_run ?? inputs.dryRun)
    };
  }
  if (action === "notebook.edit") {
    return {
      type: "notebook.edit",
      notebookPath: requiredStringInput(inputs.notebook_path ?? inputs.notebookPath ?? inputs.path, "NotebookEdit requires notebook_path"),
      cellId: optionalStringInput(inputs.cell_id ?? inputs.cellId),
      newSource: optionalStringInput(inputs.new_source ?? inputs.newSource),
      cellType: notebookCellTypeInput(inputs.cell_type ?? inputs.cellType),
      editMode: notebookEditModeInput(inputs.edit_mode ?? inputs.editMode)
    };
  }
  if (action === "code.test") {
    return {
      type: "code.test",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout)
    };
  }
  if (action === "code.lint") {
    return {
      type: "code.lint",
      root: optionalStringInput(inputs.root ?? inputs.path),
      include: optionalStringInput(inputs.include)
    };
  }
  if (action === "code.build") {
    return {
      type: "code.build",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes)
    };
  }
  if (action === "git.status") {
    return { type: "git.status", cwd: optionalStringInput(inputs.cwd) };
  }
  if (action === "git.diff") {
    return {
      type: "git.diff",
      cwd: optionalStringInput(inputs.cwd),
      staged: inputs.staged === true || inputs.staged === "true"
    };
  }
  if (action === "git.log") {
    return {
      type: "git.log",
      cwd: optionalStringInput(inputs.cwd),
      maxCommits: numberInput(inputs.maxCommits ?? inputs.max_commits)
    };
  }
  if (action === "git.branch") {
    const branchAction = String(inputs.operation ?? inputs.branchAction ?? inputs.branch_action ?? inputs.command ?? "list");
    return {
      type: "git.branch",
      cwd: optionalStringInput(inputs.cwd),
      action: branchAction === "create" ? "create" : branchAction === "switch" ? "switch" : "list",
      name: optionalStringInput(inputs.name)
    };
  }
  if (action === "git.show") {
    return {
      type: "git.show",
      cwd: optionalStringInput(inputs.cwd),
      revision: optionalStringInput(inputs.revision ?? inputs.rev ?? inputs.ref),
      path: optionalStringInput(inputs.path),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes)
    };
  }
  if (action === "package.install") {
    return {
      type: "package.install",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout)
    };
  }
  if (action === "package.info") {
    return {
      type: "package.info",
      cwd: optionalStringInput(inputs.cwd),
      manifest: optionalStringInput(inputs.manifest ?? inputs.path)
    };
  }
  if (action === "project.detect") {
    return {
      type: "project.detect",
      root: optionalStringInput(inputs.root ?? inputs.cwd ?? inputs.path)
    };
  }
  if (isLspActionType(action)) {
    return normalizeLspAction(action, inputs);
  }
  if (action === "agent.list") {
    return {
      type: "agent.list",
      parent_session_id: optionalStringInput(inputs.parent_session_id ?? inputs.parentSessionId ?? inputs.session_id ?? inputs.sessionId),
      status: agentWorkerStatusInput(inputs.status),
      limit: numberInput(inputs.limit)
    };
  }
  if (action === "agent.status") {
    return {
      type: "agent.status",
      worker_id: requiredStringInput(inputs.worker_id ?? inputs.workerId ?? inputs.agent_id ?? inputs.agentId, "agent.status requires worker_id")
    };
  }
  if (action === "agent.stop") {
    return {
      type: "agent.stop",
      worker_id: requiredStringInput(inputs.worker_id ?? inputs.workerId ?? inputs.agent_id ?? inputs.agentId, "agent.stop requires worker_id")
    };
  }
  if (action === "agent.continue") {
    return {
      type: "agent.continue",
      worker_id: requiredStringInput(inputs.worker_id ?? inputs.workerId ?? inputs.agent_id ?? inputs.agentId, "agent.continue requires worker_id"),
      message: requiredStringInput(inputs.message ?? inputs.prompt ?? inputs.instruction ?? inputs.task, "agent.continue requires message"),
      run_in_background: booleanInput(inputs.runInBackground ?? inputs.run_in_background)
    };
  }
  if (action === "task.create") {
    return {
      type: "task.create",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: optionalStringInput(inputs.task_id ?? inputs.taskId ?? inputs.id),
      title: requiredStringInput(inputs.title ?? inputs.summary ?? inputs.description ?? inputs.objective, "task.create requires title"),
      description: optionalStringInput(inputs.description),
      objective: optionalStringInput(inputs.objective ?? inputs.prompt),
      taskType: taskTypeInput(inputs.taskType ?? inputs.task_type ?? inputs.type),
      status: swarmTaskStatusInput(inputs.status),
      required_capabilities: stringArrayInput(inputs.required_capabilities ?? inputs.requiredCapabilities ?? inputs.capabilities),
      capability: optionalStringInput(inputs.capability),
      dependencies: stringArrayInput(inputs.dependencies ?? inputs.depends_on ?? inputs.dependsOn),
      parent_task_id: optionalStringInput(inputs.parent_task_id ?? inputs.parentTaskId),
      assigned_to: agentAddressInput(inputs.assigned_to ?? inputs.assignedTo ?? inputs.agent),
      write_policy: writePolicyInput(inputs.write_policy ?? inputs.writePolicy),
      file_scope: stringArrayInput(inputs.file_scope ?? inputs.fileScope ?? inputs.paths)
    };
  }
  if (action === "task.update") {
    return {
      type: "task.update",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: requiredStringInput(inputs.task_id ?? inputs.taskId ?? inputs.id, "task.update requires task_id"),
      title: optionalStringInput(inputs.title),
      status: swarmTaskStatusInput(inputs.status),
      summary: optionalStringInput(inputs.summary ?? inputs.message),
      last_error: optionalStringInput(inputs.last_error ?? inputs.lastError ?? inputs.error),
      attempt: numberInput(inputs.attempt),
      output: optionalStringInput(inputs.output ?? inputs.content),
      output_ref: optionalStringInput(inputs.output_ref ?? inputs.outputRef),
      progress: numberInput(inputs.progress),
      metadata: recordInput(inputs.metadata)
    };
  }
  if (action === "task.get") {
    return {
      type: "task.get",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: requiredStringInput(inputs.task_id ?? inputs.taskId ?? inputs.id, "task.get requires task_id")
    };
  }
  if (action === "task.list") {
    return {
      type: "task.list",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      status: swarmTaskStatusInput(inputs.status),
      limit: numberInput(inputs.limit),
      offset: numberInput(inputs.offset)
    };
  }
  if (action === "task.output") {
    return {
      type: "task.output",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: optionalStringInput(inputs.task_id ?? inputs.taskId ?? inputs.id),
      worker_id: optionalStringInput(inputs.worker_id ?? inputs.workerId ?? inputs.agent_id ?? inputs.agentId),
      artifact_id: optionalStringInput(inputs.artifact_id ?? inputs.artifactId),
      output_ref: optionalStringInput(inputs.output_ref ?? inputs.outputRef ?? inputs.ref ?? inputs.path),
      max_bytes: numberInput(inputs.max_bytes ?? inputs.maxBytes ?? inputs.limit),
      offset: numberInput(inputs.offset)
    };
  }
  if (action === "task.stop") {
    return {
      type: "task.stop",
      session_id: optionalStringInput(inputs.session_id ?? inputs.sessionId),
      task_id: requiredStringInput(inputs.task_id ?? inputs.taskId ?? inputs.id, "task.stop requires task_id"),
      reason: optionalStringInput(inputs.reason ?? inputs.message)
    };
  }
  if (action === "agent.delegate") {
    const runInBackground = booleanInput(inputs.runInBackground ?? inputs.run_in_background);
    const preferredMode = agentInvocationModeInput(inputs.preferred_mode ?? inputs.invocation_mode ?? inputs.mode);
    return {
      type: "agent.delegate",
      capability: requiredStringInput(inputs.capability ?? inputs.subagent_type ?? inputs.agent_type ?? (isVisibleAgentAction ? AGENT_TOOL_DEFAULT_CAPABILITY : undefined), "agent.delegate requires capability"),
      task: requiredStringInput(inputs.task ?? inputs.prompt ?? inputs.description ?? inputs.objective, "agent.delegate requires task"),
      context: optionalStringInput(inputs.context),
      preferred_agent_spec_id: optionalStringInput(inputs.preferred_agent_spec_id ?? inputs.agent_spec_id ?? inputs.agent ?? inputs.subagent_type),
      preferred_mode: runInBackground === true ? "parallel" : preferredMode,
      run_in_background: runInBackground,
      file_scope: stringArrayInput(inputs.file_scope ?? inputs.fileScope ?? inputs.paths)
    };
  }
  throw new Error(`Unsupported tool action: ${rawAction || "(empty)"}`);
}

export async function runLocalTool(action: ToolAction, context: LocalToolContext): Promise<ToolResult> {
  assertToolAllowedByPermissions(action, context.settings, { workspace: context.workspace });

  if (action.type === "file.read") {
    return readLocalFile(action, context);
  }
  if (action.type === "file.list") {
    return listLocalFiles(action, context);
  }
  if (action.type === "file.glob") {
    return globLocalFiles(action, context);
  }
  if (action.type === "file.grep") {
    return grepLocalFiles(action, context);
  }
  if (action.type === "file.stat") {
    return statLocalPath(action, context);
  }
  if (action.type === "file.resolve") {
    return resolveLocalPath(action, context);
  }
  if (action.type === "file.write") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return writeLocalFile(action, context);
  }
  if (action.type === "file.edit") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return editLocalFile(action, context);
  }
  if (action.type === "file.mkdir") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return makeLocalDirectory(action, context);
  }
  if (action.type === "file.move") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return moveLocalPath(action, context);
  }
  if (action.type === "file.copy") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return copyLocalPath(action, context);
  }
  if (action.type === "file.delete") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return deleteLocalPath(action, context);
  }
  if (action.type === "file.patch") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return patchLocalFile(action, context);
  }
  if (action.type === "json.read") {
    return readJsonFile(action, context);
  }
  if (action.type === "json.edit") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct file writes are disabled by ~/.swarm/settings.json");
    }
    return editJsonFile(action, context);
  }
  if (action.type === "todo.write") {
    return writeTodos(action, context);
  }
  if (action.type === "ask_user_question") {
    return askUserQuestion(action, context);
  }
  if (action.type === "plan.enter") {
    return enterPlanMode(action, context);
  }
  if (action.type === "plan.exit") {
    return exitPlanMode(action, context);
  }
  if (action.type === "task.create") {
    return runTaskCreate(action, context);
  }
  if (action.type === "task.update") {
    return runTaskUpdate(action, context);
  }
  if (action.type === "task.get") {
    return runTaskGet(action, context);
  }
  if (action.type === "task.list") {
    return runTaskList(action, context);
  }
  if (action.type === "task.output") {
    return runTaskOutput(action, context);
  }
  if (action.type === "task.stop") {
    return runTaskStop(action, context);
  }
  if (action.type === "worktree.enter") {
    return enterWorktree(action, context);
  }
  if (action.type === "worktree.exit") {
    return exitWorktree(action, context);
  }
  if (action.type === "blackboard.write") {
    return writeBlackboard(action, context);
  }
  if (action.type === "blackboard.read") {
    return readBlackboard(action, context);
  }
  if (action.type === "blackboard.search") {
    return searchBlackboard(action, context);
  }
  if (action.type === "blackboard.list") {
    return listBlackboard(action, context);
  }
  if (action.type === "shell.exec") {
    return executeShell(action, context);
  }
  if (action.type === "powershell.exec") {
    return executePowerShell(action, context);
  }
  if (action.type === "exec") {
    return executeExec(action, context);
  }
  if (action.type === "process.start") {
    return executeProcessStart(action, context);
  }
  if (action.type === "process.status") {
    return executeProcessStatus(action, context);
  }
  if (action.type === "process.list") {
    return executeProcessList(action, context);
  }
  if (action.type === "process.tail") {
    return executeProcessTail(action, context);
  }
  if (action.type === "process.grep") {
    return executeProcessGrep(action, context);
  }
  if (action.type === "process.stop") {
    return executeProcessStop(action, context);
  }
  if (action.type === "web.search") {
    if (!context.settings.tools.webSearch) {
      throw new Error("Web search is disabled by ~/.swarm/settings.json");
    }
    return webSearch(action, context);
  }
  if (action.type === "web.fetch") {
    if (!context.settings.tools.webSearch) {
      throw new Error("Web fetch is disabled by ~/.swarm/settings.json");
    }
    return webFetch(action, context);
  }
  if (action.type === "config.get") {
    return configGet(action, context);
  }
  if (action.type === "config.set") {
    return configSet(action, context);
  }
  if (action.type === "mcp.resources") {
    return listMcpResources(action, context);
  }
  if (action.type === "mcp.read") {
    return readMcpResource(action, context);
  }
  if (action.type === "mcp.auth") {
    return mcpAuth(action, context);
  }
  if (action.type === "mcp.call") {
    return callMcpTool(action, context);
  }
  if (action.type === "skill.invoke") {
    return invokeSkill(action, context);
  }
  if (action.type === "agent.message") {
    return sendAgentMessage(action, context);
  }
  if (action.type === "runtime.sleep") {
    return runtimeSleep(action);
  }
  if (action.type === "structured.output") {
    return structuredOutput(action, context);
  }
  if (action.type === "repl.mode") {
    return replMode(action, context);
  }
  if (action.type === "schedule.create" || action.type === "schedule.list" || action.type === "schedule.delete" || action.type === "remote.trigger" || action.type === "team.create" || action.type === "team.delete") {
    return designOnlyAutomationTool(action);
  }
  if (action.type === "notebook.edit") {
    if (!context.settings.tools.directWrite) {
      throw new Error("Direct notebook edits are disabled by ~/.swarm/settings.json");
    }
    return editNotebook(action, context);
  }
  if (action.type === "code.test") {
    return executeCodeTest(action, context);
  }
  if (action.type === "code.lint") {
    return executeCodeLint(action, context);
  }
  if (action.type === "code.build") {
    return executeCodeBuild(action, context);
  }
  if (action.type === "git.status") {
    return executeGitStatus(action, context);
  }
  if (action.type === "git.diff") {
    return executeGitDiff(action, context);
  }
  if (action.type === "git.log") {
    return executeGitLog(action, context);
  }
  if (action.type === "git.branch") {
    return executeGitBranch(action, context);
  }
  if (action.type === "git.show") {
    return executeGitShow(action, context);
  }
  if (action.type === "package.install") {
    return executePackageInstall(action, context);
  }
  if (action.type === "package.info") {
    return readPackageInfo(action, context);
  }
  if (action.type === "project.detect") {
    return detectProject(action, context);
  }
  if (isLspToolAction(action)) {
    return runLspTool(action, context);
  }
  if (action.type === "agent.delegate") {
    if (!context.delegate) {
      throw new Error("agent.delegate is only available within a swarm agent process");
    }
    return context.delegate(action);
  }
  if (action.type === "agent.list") {
    if (!context.agentControl) {
      throw new Error("agent.list is only available within a swarm agent process");
    }
    return context.agentControl.list(action, agentControlToolContext(context));
  }
  if (action.type === "agent.status") {
    if (!context.agentControl) {
      throw new Error("agent.status is only available within a swarm agent process");
    }
    return context.agentControl.status(action, agentControlToolContext(context));
  }
  if (action.type === "agent.stop") {
    if (!context.agentControl) {
      throw new Error("agent.stop is only available within a swarm agent process");
    }
    return context.agentControl.stop(action, agentControlToolContext(context));
  }
  if (action.type === "agent.continue") {
    if (!context.agentControl) {
      throw new Error("agent.continue is only available within a swarm agent process");
    }
    return context.agentControl.continue(action, agentControlToolContext(context));
  }
  throw new Error(`Unsupported tool action: ${(action as ToolAction).type}`);
}

export function renderToolResultDetail(result: ToolResult): string {
  const recovery = result.recoverySuggestion ? `Recovery: ${result.recoverySuggestion}` : undefined;
  const body = result.content
    ? result.content
    : result.outputRef
      ? `Full output: ${result.outputRef}`
      : JSON.stringify(result.data ?? result.metadata ?? {}, null, 2);
  return [body, recovery].filter(Boolean).join("\n\n");
}

async function readLocalFile(action: Extract<ToolAction, { type: "file.read" }>, context: LocalToolContext): Promise<ToolResult> {
  const paths = action.paths?.length ? action.paths : action.path ? [action.path] : [];
  if (paths.length === 0) {
    throw new Error("file.read requires path");
  }
  if (paths.length > 1) {
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          return await readSingleLocalFile(
          {
            ...action,
            path,
            paths: undefined
          },
          context
          );
        } catch (error) {
          return {
            action: action.type,
            status: "failed",
            summary: `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
            content: "",
            errors: [error instanceof Error ? error.message : String(error)],
            metadata: {
              path,
              error: error instanceof Error ? error.message : String(error)
            }
          } satisfies ToolResult;
        }
      })
    );
    const failures = results.filter((result) => result.status === "failed" || result.metadata?.error).length;
    return {
      action: action.type,
      status: failures === results.length ? "failed" : failures > 0 ? "partial" : "success",
      summary: `read ${results.length - failures}/${results.length} files${failures ? `, ${failures} failed` : ""}`,
      content: results
        .map((result) =>
          result.status === "failed" || result.metadata?.error
            ? `--- ${String(result.metadata?.path ?? "file")} ---\nERROR: ${String(result.errors?.[0] ?? result.metadata?.error ?? result.summary)}`
            : `--- ${String(result.metadata?.path ?? "file")} ---\n${result.content ?? ""}`
        )
        .join("\n\n"),
      data: results.map((result) => result.metadata),
      errors: results
        .map((result) => result.metadata?.error)
        .filter((error): error is string => typeof error === "string")
    };
  }
  return readSingleLocalFile({ ...action, path: paths[0], paths: undefined }, context);
}

async function readSingleLocalFile(
  action: Extract<ToolAction, { type: "file.read" }> & { path: string },
  context: LocalToolContext
): Promise<ToolResult> {
  const resolved = resolveReadablePath(action.path, context);
  const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (targetInfo instanceof Error) {
    const errorCode = classifyFsError(targetInfo);
    return {
      action: action.type,
      status: "failed",
      summary: `file.read target not found: ${displayPath(resolved, context.workspace)}`,
      errors: [targetInfo.message],
      errorCode,
      retryable: false,
      recoverable: errorCode === "FS_NOT_FOUND",
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, errorCode, targetInfo.message),
      metadata: {
        path: displayPath(resolved, context.workspace),
        requestedPath: action.path,
        error: targetInfo.message
      }
    };
  }
  if (!targetInfo.isFile()) {
    return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
  }
  const previousSnapshot = readSnapshots.get(snapshotKey(resolved, context));
  if (previousSnapshot && previousSnapshot.mtimeMs === targetInfo.mtimeMs && readRequestMatchesSnapshot(action, previousSnapshot)) {
    return unchangedReadResult(action, resolved, context, previousSnapshot);
  }
  const rawBuffer = await readFile(resolved);
  if (rawBuffer.includes(0)) {
    const path = displayPath(resolved, context.workspace);
    return {
      action: action.type,
      status: "failed",
      summary: `refusing to return binary file content from ${path}`,
      errors: ["binary file content is not supported by file.read"],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: false,
      data: { path, bytes: rawBuffer.length, binary: true }
    };
  }
  const raw = rawBuffer.toString("utf8");
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, action.startLine ?? action.offset ?? 1);
  const requestedEnd = action.limit !== undefined
    ? startLine + Math.max(1, action.limit) - 1
    : action.endLine === -1 || action.endLine === undefined
      ? totalLines
      : action.endLine;
  const endLine = Math.max(startLine - 1, Math.min(totalLines, requestedEnd));
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  const maxBytes = Math.max(1, action.maxBytes ?? 200_000);
  const buffer = Buffer.from(selected, "utf8");
  const truncated = buffer.length > maxBytes;
  const content = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : selected;
  const currentHash = hashText(raw);
  const unchangedAfterRead = previousSnapshot && currentHash === previousSnapshot.hash && readViewMatchesSnapshot({
    startLine,
    endLine,
    totalLines,
    truncated,
    fullView: startLine === 1 && endLine === totalLines && !truncated
  }, previousSnapshot);
  rememberReadSnapshot(resolved, raw, targetInfo.mtimeMs, context, {
    fullView: startLine === 1 && endLine === totalLines && !truncated,
    startLine,
    endLine,
    totalLines,
    truncated
  });
  const path = displayPath(resolved, context.workspace);
  if (unchangedAfterRead) {
    return unchangedReadResult(action, resolved, context, {
      ...previousSnapshot,
      mtimeMs: targetInfo.mtimeMs
    });
  }
  return {
    action: action.type,
    status: "success",
    summary: `read ${startLine}-${endLine} / ${totalLines} lines from ${path}${truncated ? " (truncated)" : ""}`,
    content,
    metadata: {
      path,
      totalLines,
      startLine,
      endLine,
      bytes: buffer.length,
      truncated
    }
  };
}

async function listLocalFiles(action: Extract<ToolAction, { type: "file.list" }>, context: LocalToolContext): Promise<ToolResult> {
  const root = resolveReadablePath(action.root || ".", context);
  const files = await collectFiles(root, context, {
    maxFiles: Math.max(1, action.maxFiles ?? 200),
    maxDepth: Math.max(0, action.maxDepth ?? 6)
  });
  return {
    action: action.type,
    status: "success",
    summary: `listed ${files.length} files under ${displayPath(root, context.workspace)}`,
    data: files.map((file) => file.display)
  };
}

async function globLocalFiles(action: Extract<ToolAction, { type: "file.glob" }>, context: LocalToolContext): Promise<ToolResult> {
  const root = resolveReadablePath(action.root || ".", context);
  const maxResults = Math.max(1, action.maxResults ?? 200);
  const files = await collectFiles(root, context, {
    maxFiles: maxResults,
    maxDepth: Math.max(0, action.maxDepth ?? 12),
    filter: (file) => matchesGlob(file.display, action.pattern) || matchesGlob(basename(file.display), action.pattern)
  });
  return {
    action: action.type,
    status: "success",
    summary: `matched ${files.length} files for ${action.pattern}`,
    data: files.map((file) => file.display)
  };
}

async function grepLocalFiles(action: Extract<ToolAction, { type: "file.grep" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.pattern) {
    throw new Error("file.grep requires pattern");
  }
  const root = resolveReadablePath(action.root || ".", context);
  const rootInfo = await stat(root).catch((error: unknown) => error as Error);
  if (rootInfo instanceof Error) {
    const errorCode = classifyFsError(rootInfo);
    return {
      action: action.type,
      status: "failed",
      summary: `grep root not found: ${displayPath(root, context.workspace)}`,
      errors: [rootInfo.message],
      errorCode,
      retryable: false,
      recoverable: errorCode === "FS_NOT_FOUND",
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, errorCode, rootInfo.message),
      data: {
        root: displayPath(root, context.workspace),
        requestedRoot: action.root || ".",
        pattern: action.pattern
      }
    };
  }
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) {
    return {
      action: action.type,
      status: "failed",
      summary: `grep root is not a file or directory: ${displayPath(root, context.workspace)}`,
      errors: [`not a file or directory: ${displayPath(root, context.workspace)}`],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: false,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, "INVALID_INPUT", `not a file or directory: ${displayPath(root, context.workspace)}`),
      data: {
        root: displayPath(root, context.workspace),
        requestedRoot: action.root || ".",
        pattern: action.pattern
      }
    };
  }
  const outputMode = action.outputMode ?? "content";
  const regex = compileSearchRegex(action.pattern, action.caseInsensitive, action.multiline);
  const maxMatches = grepMaxMatches(action);
  const contextLines = Math.max(0, action.contextLines ?? 0);
  const beforeContext = Math.max(0, action.beforeContext ?? contextLines);
  const afterContext = Math.max(0, action.afterContext ?? contextLines);
  const rgResult = await grepLocalFilesWithRipgrep({
    root,
    action,
    context,
    maxMatches,
    beforeContext,
    afterContext,
    runCommand: runDirectCommand,
    displayPath,
    isPathDenied
  });
  if (rgResult) {
    const matches = Array.isArray(rgResult.data) ? rgResult.data as GrepMatch[] : [];
    return formatGrepToolResult({
      action,
      matches,
      root,
      context,
      engine: "ripgrep",
      truncated: Boolean(rgResult.metadata?.truncated),
      outputMode
    });
  }
  const files = await collectFiles(root, context, {
    maxFiles: GREP_FALLBACK_MAX_FILES,
    maxDepth: GREP_FALLBACK_MAX_DEPTH,
    filter: (file) => matchesGrepFileFilter(file, action)
  });
  const matches: GrepMatch[] = [];
  for (const file of files) {
    if (matches.length >= maxMatches) {
      break;
    }
    const text = await readTextIfPossible(file.path);
    if (text === undefined) {
      continue;
    }
    if (action.multiline) {
      matches.push(...grepMultilineFile({
        file,
        text,
        regex,
        limit: maxMatches - matches.length,
        beforeContext,
        afterContext
      }));
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) {
        continue;
      }
      regex.lastIndex = 0;
      matches.push({
        path: file.display,
        line: index + 1,
        text: lines[index],
        before: beforeContext ? lines.slice(Math.max(0, index - beforeContext), index) : undefined,
        after: afterContext ? lines.slice(index + 1, index + 1 + afterContext) : undefined
      });
      if (matches.length >= maxMatches) {
        break;
      }
    }
  }
  return formatGrepToolResult({
    action,
    matches,
    root,
    context,
    engine: "js-fallback",
    scannedFiles: files.length,
    fileLimit: GREP_FALLBACK_MAX_FILES,
    truncated: files.length >= GREP_FALLBACK_MAX_FILES,
    outputMode
  });
}

function formatGrepToolResult(input: {
  action: Extract<ToolAction, { type: "file.grep" }>;
  matches: GrepMatch[];
  root: string;
  context: LocalToolContext;
  engine: string;
  scannedFiles?: number;
  fileLimit?: number;
  truncated?: boolean;
  outputMode?: NonNullable<Extract<ToolAction, { type: "file.grep" }>["outputMode"]>;
}): ToolResult {
  const outputMode = input.outputMode ?? input.action.outputMode ?? "content";
  const { items, appliedLimit, appliedOffset, totalBeforePaging } = pageGrepItems(input.matches, input.action);
  const matchFiles = uniqueGrepPaths(input.matches);
  const metadata: Record<string, unknown> = {
    root: displayPath(input.root, input.context.workspace),
    requestedRoot: input.action.root || ".",
    engine: input.engine,
    outputMode,
    matchCount: input.matches.length,
    totalBeforePaging,
    appliedLimit,
    appliedOffset,
    scannedFiles: input.scannedFiles,
    fileLimit: input.fileLimit,
    truncated: input.truncated || appliedLimit !== undefined
  };
  if (outputMode === "files_with_matches") {
    const paths = uniqueGrepPaths(items);
    return {
      action: input.action.type,
      status: "success",
      summary: `found ${paths.length} files for ${input.action.pattern}${appliedLimit !== undefined ? ` (limited to ${appliedLimit})` : ""}`,
      content: paths.join("\n"),
      data: paths,
      metadata: { ...metadata, fileCount: matchFiles.length }
    };
  }
  if (outputMode === "count") {
    const counts = countGrepMatchesByPath(items);
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    return {
      action: input.action.type,
      status: "success",
      summary: `found ${total} matches across ${counts.length} files for ${input.action.pattern}${appliedLimit !== undefined ? ` (limited to ${appliedLimit})` : ""}`,
      content: counts.map((item) => `${item.path}:${item.count}`).join("\n"),
      data: counts,
      metadata: { ...metadata, fileCount: matchFiles.length }
    };
  }
  return {
    action: input.action.type,
    status: "success",
    summary: `found ${items.length} matches for ${input.action.pattern}${appliedLimit !== undefined ? ` (limited to ${appliedLimit})` : ""}`,
    content: renderGrepMatches(items),
    data: items,
    metadata: { ...metadata, fileCount: matchFiles.length }
  };
}

async function statLocalPath(action: Extract<ToolAction, { type: "file.stat" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveReadablePath(action.path, context);
  const info = await stat(resolved);
  let lineCount: number | undefined;
  if (info.isFile() && info.size <= 1_000_000) {
    const text = await readTextIfPossible(resolved);
    lineCount = text ? text.split(/\r?\n/).length : undefined;
  }
  const data = {
    path: displayPath(resolved, context.workspace),
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    lineCount
  };
  return {
    action: action.type,
    status: "success",
    summary: `${data.path}: ${data.type}, ${data.bytes} bytes${lineCount ? `, ${lineCount} lines` : ""}`,
    data
  };
}

async function resolveLocalPath(action: Extract<ToolAction, { type: "file.resolve" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolve(context.workspace, action.path);
  const info = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
  const readable = permissionCheck(() => resolveReadablePath(action.path, context));
  const writable = permissionCheck(() => resolveWritablePath(action.path, context));
  const exists = !(info instanceof Error);
  const data = {
    requestedPath: action.path,
    path: displayPath(resolved, context.workspace),
    absolutePath: resolved,
    exists,
    type: exists ? info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" : undefined,
    bytes: exists ? info.size : undefined,
    readable,
    writable
  };
  return {
    action: action.type,
    status: "success",
    summary: `${data.path}: ${exists ? data.type : "missing"}, readable=${readable.allowed}, writable=${writable.allowed}`,
    data
  };
}

async function writeLocalFile(action: Extract<ToolAction, { type: "file.write" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
  const release = acquireWriteLock(resolved, context);
  try {
    const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
    if (!(targetInfo instanceof Error) && !targetInfo.isFile()) {
      return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
    }
    if (targetInfo instanceof Error && classifyFsError(targetInfo) !== "FS_NOT_FOUND") {
      throw targetInfo;
    }
    const existed = !(targetInfo instanceof Error) && targetInfo.isFile();
    await assertWritePrecondition(resolved, context);
    const original = existed ? await readFile(resolved, "utf8") : "";
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, action.content, "utf8");
    const info = await stat(resolved);
    rememberReadSnapshot(resolved, action.content, info.mtimeMs, context);
    const bytes = Buffer.byteLength(action.content, "utf8");
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: existed ? "update" : "create",
      before: original,
      after: action.content,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `${existed ? "updated" : "created"} ${bytes} bytes at ${path}`,
      data: {
        path,
        bytes,
        operation: existed ? "update" : "create",
        change,
        diff: createSimpleDiff(path, original, action.content)
      }
    };
  } finally {
    release();
  }
}

async function makeLocalDirectory(action: Extract<ToolAction, { type: "file.mkdir" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
  const existing = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (!(existing instanceof Error) && !existing.isDirectory()) {
    return {
      action: action.type,
      status: "failed",
      summary: `file.mkdir target exists and is not a directory: ${displayPath(resolved, context.workspace)}`,
      errors: [`target exists and is not a directory: ${displayPath(resolved, context.workspace)}`],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { path: displayPath(resolved, context.workspace), requestedPath: action.path, targetType: fileTargetKind(existing) }
    };
  }
  if (existing instanceof Error && classifyFsError(existing) !== "FS_NOT_FOUND") {
    throw existing;
  }
  await mkdir(resolved, { recursive: action.recursive ?? true });
  const path = displayPath(resolved, context.workspace);
  const change = createWorkspaceChange({
    path,
    operation: "mkdir",
    before: "",
    after: path,
    context
  });
  context.onWorkspaceChange?.(change);
  return {
    action: action.type,
    status: "success",
    summary: `${existing instanceof Error ? "created" : "confirmed"} directory ${path}`,
    data: { path, operation: existing instanceof Error ? "create" : "exists", change }
  };
}

async function moveLocalPath(action: Extract<ToolAction, { type: "file.move" }>, context: LocalToolContext): Promise<ToolResult> {
  const source = resolveWritablePath(action.source, context, "Edit");
  const destination = resolveWritablePath(action.destination, context);
  const sourceInfo = await stat(source).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (sourceInfo instanceof Error) {
    const errorCode = classifyFsError(sourceInfo);
    return fsFailureResult(action.type, source, action.source, context, `file.move source not found`, sourceInfo, errorCode);
  }
  const destinationInfo = await stat(destination).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (!(destinationInfo instanceof Error) && !action.overwrite) {
    return {
      action: action.type,
      status: "failed",
      summary: `file.move destination already exists: ${displayPath(destination, context.workspace)}`,
      errors: [`destination already exists: ${displayPath(destination, context.workspace)}`],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { source: displayPath(source, context.workspace), destination: displayPath(destination, context.workspace) }
    };
  }
  if (destinationInfo instanceof Error && classifyFsError(destinationInfo) !== "FS_NOT_FOUND") {
    throw destinationInfo;
  }
  const releaseSource = acquireWriteLock(source, context);
  const releaseDestination = acquireWriteLock(destination, context);
  try {
    const original = sourceInfo.isFile() ? await readFile(source, "utf8").catch(() => "") : "";
    if (sourceInfo.isFile()) {
      await assertWritePrecondition(source, context);
    }
    if (!(destinationInfo instanceof Error)) {
      await rm(destination, { recursive: destinationInfo.isDirectory(), force: true });
    }
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    if (sourceInfo.isFile()) {
      const info = await stat(destination);
      rememberReadSnapshot(destination, original, info.mtimeMs, context);
    }
    const sourceDisplay = displayPath(source, context.workspace);
    const destinationDisplay = displayPath(destination, context.workspace);
    const change = createWorkspaceChange({
      path: destinationDisplay,
      operation: "move",
      before: sourceDisplay,
      after: destinationDisplay,
      context,
      lockKey: `${releaseSource.key},${releaseDestination.key}`
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `moved ${sourceDisplay} to ${destinationDisplay}`,
      data: {
        source: sourceDisplay,
        destination: destinationDisplay,
        targetType: fileTargetKind(sourceInfo),
        overwritten: !(destinationInfo instanceof Error),
        change
      }
    };
  } finally {
    releaseDestination();
    releaseSource();
  }
}

async function copyLocalPath(action: Extract<ToolAction, { type: "file.copy" }>, context: LocalToolContext): Promise<ToolResult> {
  const source = resolveReadablePath(action.source, context);
  const destination = resolveWritablePath(action.destination, context);
  const sourceInfo = await stat(source).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (sourceInfo instanceof Error) {
    return fsFailureResult(action.type, source, action.source, context, "file.copy source not found", sourceInfo, classifyFsError(sourceInfo));
  }
  if (sourceInfo.isDirectory() && !action.recursive) {
    return {
      action: action.type,
      status: "failed",
      summary: `file.copy source is a directory; set recursive=true to copy it: ${displayPath(source, context.workspace)}`,
      errors: ["recursive=true is required to copy directories"],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { source: displayPath(source, context.workspace), destination: displayPath(destination, context.workspace) }
    };
  }
  const destinationInfo = await stat(destination).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (!(destinationInfo instanceof Error) && !action.overwrite) {
    return {
      action: action.type,
      status: "failed",
      summary: `file.copy destination already exists: ${displayPath(destination, context.workspace)}`,
      errors: [`destination already exists: ${displayPath(destination, context.workspace)}`],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { source: displayPath(source, context.workspace), destination: displayPath(destination, context.workspace) }
    };
  }
  if (destinationInfo instanceof Error && classifyFsError(destinationInfo) !== "FS_NOT_FOUND") {
    throw destinationInfo;
  }
  const release = acquireWriteLock(destination, context);
  try {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: action.recursive ?? false, force: action.overwrite ?? false, errorOnExist: !(action.overwrite ?? false) });
    const copiedInfo = await stat(destination);
    if (copiedInfo.isFile()) {
      const copied = await readFile(destination, "utf8").catch(() => "");
      rememberReadSnapshot(destination, copied, copiedInfo.mtimeMs, context);
    }
    const sourceDisplay = displayPath(source, context.workspace);
    const destinationDisplay = displayPath(destination, context.workspace);
    const change = createWorkspaceChange({
      path: destinationDisplay,
      operation: "copy",
      before: sourceDisplay,
      after: destinationDisplay,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `copied ${sourceDisplay} to ${destinationDisplay}`,
      data: {
        source: sourceDisplay,
        destination: destinationDisplay,
        targetType: fileTargetKind(sourceInfo),
        overwritten: !(destinationInfo instanceof Error),
        change
      }
    };
  } finally {
    release();
  }
}

async function deleteLocalPath(action: Extract<ToolAction, { type: "file.delete" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context, "Edit");
  const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (targetInfo instanceof Error) {
    return fsFailureResult(action.type, resolved, action.path, context, "file.delete target not found", targetInfo, classifyFsError(targetInfo));
  }
  if (targetInfo.isDirectory() && !action.recursive) {
    return {
      action: action.type,
      status: "failed",
      summary: `file.delete target is a directory; set recursive=true to delete it: ${displayPath(resolved, context.workspace)}`,
      errors: ["recursive=true is required to delete directories"],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { path: displayPath(resolved, context.workspace), requestedPath: action.path }
    };
  }
  const release = acquireWriteLock(resolved, context);
  try {
    if (targetInfo.isFile()) {
      await assertWritePrecondition(resolved, context);
    }
    const original = targetInfo.isFile() ? await readFile(resolved, "utf8").catch(() => "") : "";
    await rm(resolved, { recursive: action.recursive ?? false, force: false });
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: "delete",
      before: original || path,
      after: "",
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `deleted ${path}`,
      data: {
        path,
        operation: "delete",
        targetType: fileTargetKind(targetInfo),
        change
      }
    };
  } finally {
    release();
  }
}

async function patchLocalFile(action: Extract<ToolAction, { type: "file.patch" }>, context: LocalToolContext): Promise<ToolResult> {
  if (action.hunks.length === 0) {
    throw new Error("file.patch requires at least one hunk");
  }
  const resolved = resolveWritablePath(action.path, context, "Edit");
  const release = acquireWriteLock(resolved, context);
  try {
    const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
    if (targetInfo instanceof Error) {
      return fsFailureResult(action.type, resolved, action.path, context, "file.patch target not found", targetInfo, classifyFsError(targetInfo));
    }
    if (!targetInfo.isFile()) {
      return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
    }
    if (resolved.toLowerCase().endsWith(".ipynb")) {
      return notebookRequiresNotebookEditResult(action.type, resolved, action.path, context);
    }
    await assertWritePrecondition(resolved, context);
    const original = await readFile(resolved, "utf8");
    let next = original;
    for (const [index, hunk] of action.hunks.entries()) {
      if (!hunk.oldText) {
        throw new Error(`file.patch hunk ${index + 1} requires oldText`);
      }
      const matches = next.split(hunk.oldText).length - 1;
      if (matches !== 1) {
        throw new Error(`file.patch hunk ${index + 1} requires exactly one match; found ${matches}.`);
      }
      next = next.replace(hunk.oldText, hunk.newText);
    }
    await writeFile(resolved, next, "utf8");
    const info = await stat(resolved);
    rememberReadSnapshot(resolved, next, info.mtimeMs, context);
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: "edit",
      before: original,
      after: next,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `patched ${path} with ${action.hunks.length} hunk(s)`,
      data: {
        path,
        hunks: action.hunks.length,
        beforeBytes: Buffer.byteLength(original, "utf8"),
        afterBytes: Buffer.byteLength(next, "utf8"),
        change,
        diff: createSimpleDiff(path, original, next)
      }
    };
  } finally {
    release();
  }
}

async function readJsonFile(action: Extract<ToolAction, { type: "json.read" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveReadablePath(action.path, context);
  const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (targetInfo instanceof Error) {
    return fsFailureResult(action.type, resolved, action.path, context, "json.read target not found", targetInfo, classifyFsError(targetInfo));
  }
  if (!targetInfo.isFile()) {
    return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
  }
  const raw = await readFile(resolved, "utf8");
  rememberReadSnapshot(resolved, raw, targetInfo.mtimeMs, context);
  const parsed = parseJsonWithContext(raw, action.path);
  const value = action.pointer ? readJsonPointer(parsed, action.pointer) : parsed;
  const path = displayPath(resolved, context.workspace);
  return {
    action: action.type,
    status: "success",
    summary: `read JSON${action.pointer ? ` pointer ${action.pointer}` : ""} from ${path}`,
    content: JSON.stringify(value, null, 2),
    data: value,
    metadata: { path, pointer: action.pointer }
  };
}

async function editJsonFile(action: Extract<ToolAction, { type: "json.edit" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context, "Edit");
  const release = acquireWriteLock(resolved, context);
  try {
    const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
    if (targetInfo instanceof Error) {
      return fsFailureResult(action.type, resolved, action.path, context, "json.edit target not found", targetInfo, classifyFsError(targetInfo));
    }
    if (!targetInfo.isFile()) {
      return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
    }
    if (resolved.toLowerCase().endsWith(".ipynb")) {
      return notebookRequiresNotebookEditResult(action.type, resolved, action.path, context);
    }
    await assertWritePrecondition(resolved, context);
    const original = await readFile(resolved, "utf8");
    const parsed = parseJsonWithContext(original, action.path);
    applyJsonEdit(parsed, action.pointer, action.operation, action.value);
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    await writeFile(resolved, next, "utf8");
    const info = await stat(resolved);
    rememberReadSnapshot(resolved, next, info.mtimeMs, context);
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: "edit",
      before: original,
      after: next,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `json.edit ${action.operation} ${action.pointer} in ${path}`,
      data: {
        path,
        operation: action.operation,
        pointer: action.pointer,
        change,
        diff: createSimpleDiff(path, original, next)
      }
    };
  } finally {
    release();
  }
}

async function editNotebook(action: Extract<ToolAction, { type: "notebook.edit" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.notebookPath, context, "Edit");
  const release = acquireWriteLock(resolved, context);
  try {
    const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
    if (targetInfo instanceof Error) {
      return fsFailureResult(action.type, resolved, action.notebookPath, context, "NotebookEdit target not found", targetInfo, classifyFsError(targetInfo));
    }
    if (!targetInfo.isFile()) {
      return invalidFileTargetResult(action.type, resolved, action.notebookPath, context, fileTargetKind(targetInfo));
    }
    if (!resolved.toLowerCase().endsWith(".ipynb")) {
      return {
        action: action.type,
        status: "failed",
        summary: `NotebookEdit requires a .ipynb file: ${displayPath(resolved, context.workspace)}`,
        errors: ["notebook_path must end with .ipynb"],
        errorCode: "INVALID_INPUT",
        retryable: false,
        recoverable: true,
        data: { path: displayPath(resolved, context.workspace), requestedPath: action.notebookPath }
      };
    }
    await assertWritePrecondition(resolved, context);
    const original = await readFile(resolved, "utf8");
    const notebook = parseJsonWithContext(original, action.notebookPath);
    if (!isRecord(notebook) || !Array.isArray(notebook.cells)) {
      throw new Error("NotebookEdit requires an ipynb JSON object with a cells array");
    }

    const editMode = action.editMode ?? "replace";
    const cells = notebook.cells as unknown[];
    let cellIndex = action.cellId ? cells.findIndex((cell) => isRecord(cell) && cell.id === action.cellId) : -1;
    if ((editMode === "replace" || editMode === "delete") && cellIndex < 0) {
      throw new Error(`${action.type} ${editMode} requires a matching cell_id`);
    }
    if ((editMode === "replace" || editMode === "insert") && action.newSource === undefined) {
      throw new Error(`${action.type} ${editMode} requires new_source`);
    }
    if (editMode === "delete") {
      cells.splice(cellIndex, 1);
    } else if (editMode === "insert") {
      const cellType = action.cellType ?? "code";
      const newCell = createNotebookCell(cellType, action.newSource ?? "");
      const insertAt = cellIndex < 0 ? 0 : cellIndex + 1;
      cells.splice(insertAt, 0, newCell);
      cellIndex = insertAt;
    } else {
      const target = cells[cellIndex];
      if (!isRecord(target)) {
        throw new Error("NotebookEdit target cell is not an object");
      }
      if (action.cellType) {
        target.cell_type = action.cellType;
      }
      target.source = notebookSourceLines(action.newSource ?? "");
    }

    const next = `${JSON.stringify(notebook, null, 2)}\n`;
    await writeFile(resolved, next, "utf8");
    const info = await stat(resolved);
    rememberReadSnapshot(resolved, next, info.mtimeMs, context);
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: "edit",
      before: original,
      after: next,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `NotebookEdit ${editMode} cell in ${path}`,
      data: {
        path,
        editMode,
        cellId: action.cellId,
        cellIndex,
        change,
        diff: createSimpleDiff(path, original, next)
      }
    };
  } finally {
    release();
  }
}

async function editLocalFile(action: Extract<ToolAction, { type: "file.edit" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context, "Edit");
  const release = acquireWriteLock(resolved, context);
  try {
    const targetInfo = await stat(resolved).catch((error: unknown) => error as NodeJS.ErrnoException);
    if (targetInfo instanceof Error) {
      const errorCode = classifyFsError(targetInfo);
      return {
        action: action.type,
        status: "failed",
        summary: `file.edit target not found: ${displayPath(resolved, context.workspace)}`,
        errors: [targetInfo.message],
        errorCode,
        retryable: false,
        recoverable: errorCode === "FS_NOT_FOUND",
        recoverySuggestion: recoverySuggestionForToolFailure(action.type, errorCode, targetInfo.message),
        data: {
          path: displayPath(resolved, context.workspace),
          requestedPath: action.path
        }
      };
    }
    if (!targetInfo.isFile()) {
      return invalidFileTargetResult(action.type, resolved, action.path, context, fileTargetKind(targetInfo));
    }
    if (resolved.toLowerCase().endsWith(".ipynb")) {
      return notebookRequiresNotebookEditResult(action.type, resolved, action.path, context);
    }
    await assertWritePrecondition(resolved, context);
    const original = await readFile(resolved, "utf8");
    let next: string;
    if (action.operation === "insert") {
      const insert = action.content ?? action.newText ?? "";
      if (!insert) {
        throw new Error("file.edit insert requires content");
      }
      if (action.line === undefined || action.line === -1) {
        const newline = detectLineEnding(original);
        next = `${original}${endsWithLineEnding(original) ? "" : newline}${insert}`;
      } else {
        const newline = detectLineEnding(original);
        const lines = original.split(/\r?\n/);
        const index = Math.max(0, Math.min(lines.length, action.line - 1));
        lines.splice(index, 0, insert);
        next = lines.join(newline);
      }
    } else {
      if (!action.oldText) {
        throw new Error("file.edit str_replace requires oldText");
      }
      const matches = original.split(action.oldText).length - 1;
      if (action.replaceAll && matches < 1) {
        throw new Error("file.edit replace_all requires at least one match; found 0.");
      }
      if (!action.replaceAll && matches !== 1) {
        throw new Error(`file.edit str_replace requires exactly one match; found ${matches}. Use file.grep or file.read to narrow the replacement target, then retry with a unique oldText.`);
      }
      next = action.replaceAll ? original.split(action.oldText).join(action.newText ?? "") : original.replace(action.oldText, action.newText ?? "");
    }
    await writeFile(resolved, next, "utf8");
    const info = await stat(resolved);
    rememberReadSnapshot(resolved, next, info.mtimeMs, context);
    const path = displayPath(resolved, context.workspace);
    const change = createWorkspaceChange({
      path,
      operation: "edit",
      before: original,
      after: next,
      context,
      lockKey: release.key
    });
    context.onWorkspaceChange?.(change);
    return {
      action: action.type,
      status: "success",
      summary: `edited ${path}`,
      data: {
        path,
        operation: "edit",
        beforeBytes: Buffer.byteLength(original, "utf8"),
        afterBytes: Buffer.byteLength(next, "utf8"),
        change,
        diff: createSimpleDiff(path, original, next)
      }
    };
  } finally {
    release();
  }
}

function invalidFileTargetResult(
  action: ToolAction["type"],
  resolved: string,
  requestedPath: string,
  context: LocalToolContext,
  targetType: string
): ToolResult {
  const path = displayPath(resolved, context.workspace);
  return {
    action,
    status: "failed",
    summary: `${action} target is a ${targetType}, not a file: ${path}`,
    errors: [`target is a ${targetType}, not a file: ${path}`],
    errorCode: "INVALID_INPUT",
    retryable: false,
    recoverable: action !== "file.read",
    recoverySuggestion: invalidFileTargetRecovery(action),
    data: {
      path,
      requestedPath,
      targetType
    }
  };
}

function invalidFileTargetRecovery(action: ToolAction["type"]): string {
  if (action === "file.read") {
    return "Use file.list, file.glob, or file.grep to select a concrete file, then retry file.read with that file path.";
  }
  return `Use file.stat or file.list to inspect the target, then retry ${action} with a full file path including a filename.`;
}

function notebookRequiresNotebookEditResult(
  action: ToolAction["type"],
  resolved: string,
  requestedPath: string,
  context: LocalToolContext
): ToolResult {
  const path = displayPath(resolved, context.workspace);
  return {
    action,
    status: "failed",
    summary: `${action} cannot edit notebook files: ${path}`,
    errors: ["Use notebook.edit for .ipynb files."],
    errorCode: "INVALID_INPUT",
    retryable: false,
    recoverable: true,
    recoverySuggestion: "Use notebook.edit with notebookPath, editMode, cellId when replacing/deleting, and newSource when inserting/replacing.",
    data: { path, requestedPath }
  };
}

function fileTargetKind(info: Pick<Awaited<ReturnType<typeof stat>>, "isDirectory" | "isFile">): string {
  if (info.isDirectory()) {
    return "directory";
  }
  if (info.isFile()) {
    return "file";
  }
  return "non-file";
}

function readRequestMatchesSnapshot(action: Extract<ToolAction, { type: "file.read" }>, snapshot: ReadSnapshot): boolean {
  const startLine = Math.max(1, action.startLine ?? action.offset ?? 1);
  const requestedEnd = action.limit !== undefined
    ? startLine + Math.max(1, action.limit) - 1
    : action.endLine === -1 || action.endLine === undefined
      ? snapshot.totalLines
      : action.endLine;
  const endLine = Math.max(startLine - 1, Math.min(snapshot.totalLines, requestedEnd));
  const fullView = startLine === 1 && endLine === snapshot.totalLines;
  return readViewMatchesSnapshot({ startLine, endLine, totalLines: snapshot.totalLines, truncated: false, fullView }, snapshot);
}

function readViewMatchesSnapshot(
  view: Pick<ReadSnapshot, "fullView" | "startLine" | "endLine" | "totalLines" | "truncated">,
  snapshot: ReadSnapshot
): boolean {
  return view.fullView === snapshot.fullView &&
    view.startLine === snapshot.startLine &&
    view.endLine === snapshot.endLine &&
    view.totalLines === snapshot.totalLines &&
    view.truncated === snapshot.truncated;
}

function unchangedReadResult(
  action: Extract<ToolAction, { type: "file.read" }>,
  resolved: string,
  context: LocalToolContext,
  snapshot: ReadSnapshot
): ToolResult {
  const path = displayPath(resolved, context.workspace);
  return {
    action: action.type,
    status: "success",
    summary: `read skipped for unchanged ${path}`,
    content: "",
    metadata: {
      path,
      totalLines: snapshot.totalLines,
      startLine: snapshot.startLine,
      endLine: snapshot.endLine,
      truncated: snapshot.truncated,
      unchanged: true
    }
  };
}

async function assertWritePrecondition(path: string, context: LocalToolContext): Promise<void> {
  const currentInfo = await stat(path).catch(() => undefined);
  if (!currentInfo?.isFile()) {
    return;
  }

  const snapshot = readSnapshots.get(snapshotKey(path, context));
  if (!snapshot) {
    throw new Error(
      `Refusing to modify existing file before reading it in this session: ${displayPath(path, context.workspace)}`
    );
  }
  if (!snapshot.fullView) {
    throw new Error(
      `Refusing to modify ${displayPath(path, context.workspace)} after only reading lines ${snapshot.startLine}-${snapshot.endLine}/${snapshot.totalLines}${snapshot.truncated ? " with truncation" : ""}. Read the full file first.`
    );
  }

  const current = await readFile(path, "utf8");
  const currentHash = hashText(current);
  if (currentHash !== snapshot.hash) {
    throw new Error(
      `Refusing to modify ${displayPath(path, context.workspace)} because it changed after the last read. Read it again first.`
    );
  }
}

function rememberReadSnapshot(
  path: string,
  content: string,
  mtimeMs: number,
  context: LocalToolContext,
  view: Pick<ReadSnapshot, "fullView" | "startLine" | "endLine" | "totalLines" | "truncated"> = {
    fullView: true,
    startLine: 1,
    endLine: content.split(/\r?\n/).length,
    totalLines: content.split(/\r?\n/).length,
    truncated: false
  }
): void {
  readSnapshots.set(snapshotKey(path, context), { mtimeMs, hash: hashText(content), ...view });
}

function acquireWriteLock(path: string, context: LocalToolContext): (() => void) & { key: string } {
  const key = `file.write:${resolve(path).toLowerCase()}`;
  const holder = `${context.sessionId ?? "session"}:${context.taskId ?? "task"}`;
  const existing = writeLocks.get(key);
  const display = displayPath(path, context.workspace);
  if (existing && existing.holder !== holder) {
    const reason = `Write lock for ${display} is held by ${existing.holder}`;
    context.onFileLock?.({ key, path: display, status: "blocked", holder: existing.holder, sessionId: context.sessionId, taskId: context.taskId, reason });
    throw new Error(reason);
  }
  writeLocks.set(key, { holder, acquiredAt: new Date().toISOString() });
  context.onFileLock?.({ key, path: display, status: "acquired", holder, sessionId: context.sessionId, taskId: context.taskId });
  const release = (() => {
    const current = writeLocks.get(key);
    if (current?.holder === holder) {
      writeLocks.delete(key);
      context.onFileLock?.({ key, path: display, status: "released", holder, sessionId: context.sessionId, taskId: context.taskId });
    }
  }) as (() => void) & { key: string };
  release.key = key;
  return release;
}

function createWorkspaceChange(input: {
  path: string;
  operation: WorkspaceChangeMetadata["operation"];
  before: string;
  after: string;
  context: LocalToolContext;
  lockKey?: string;
}): WorkspaceChangeMetadata {
  return {
    path: input.path,
    operation: input.operation,
    beforeHash: input.before ? hashText(input.before) : undefined,
    afterHash: hashText(input.after),
    beforeBytes: Buffer.byteLength(input.before, "utf8"),
    afterBytes: Buffer.byteLength(input.after, "utf8"),
    sessionId: input.context.sessionId,
    taskId: input.context.taskId,
    lockKey: input.lockKey
  };
}

async function writeTodos(action: Extract<ToolAction, { type: "todo.write" }>, context: LocalToolContext): Promise<ToolResult> {
  const inProgress = action.todos.filter((todo) => todo.status === "in_progress");
  if (inProgress.length > 1) {
    return {
      action: action.type,
      status: "failed",
      summary: "todo.write allows at most one in_progress item",
      errors: ["at most one todo may be in_progress"],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      data: { todos: action.todos }
    };
  }

  const key = [context.sessionId ?? "session", context.taskId ?? "task"].join(":");
  const previous = todoStates.get(key) ?? [];
  todoStates.set(key, action.todos);
  const pending = action.todos.filter((todo) => todo.status === "pending").length;
  const completed = action.todos.filter((todo) => todo.status === "completed").length;
  const verificationNudge = completed >= 3 && !action.todos.some((todo) => /test|verify|check|验证|测试/i.test(todo.content));
  return {
    action: action.type,
    status: "success",
    summary: `updated todo list: ${completed} completed, ${inProgress.length} in progress, ${pending} pending`,
    data: {
      previous,
      todos: action.todos,
      counts: { completed, inProgress: inProgress.length, pending },
      verificationNudge
    },
    content: action.todos.map((todo) => `- [${todo.status === "completed" ? "x" : " "}] ${todo.status}: ${todo.content}`).join("\n")
  };
}

async function askUserQuestion(action: Extract<ToolAction, { type: "ask_user_question" }>, context: LocalToolContext): Promise<ToolResult> {
  const questions = action.questions?.length
    ? action.questions
    : [{
        question: action.prompt,
        options: action.choices ?? []
      }];
  const choiceLabels = uniqueStrings(questions.flatMap((question) => question.options.map((option) => option.label)));
  const content = [
    action.prompt,
    action.reason ? `Reason: ${action.reason}` : undefined,
    choiceLabels.length ? `Choices: ${choiceLabels.join(", ")}` : undefined,
    action.allowFreeform ? "Free-form answer is allowed." : undefined
  ].filter(Boolean).join("\n");

  return {
    action: action.type,
    status: "partial",
    summary: "Waiting for user answer",
    content,
    recoverable: true,
    recoverySuggestion: "Wait for the user to answer, then continue with their selected choice.",
    data: {
      prompt: action.prompt,
      questions,
      defaultChoice: action.defaultChoice,
      recommendedChoice: action.recommendedChoice,
      allowFreeform: action.allowFreeform ?? true,
      reason: action.reason,
      sessionId: context.sessionId,
      taskId: context.taskId
    },
    metadata: {
      interaction: "question",
      requiresUserInput: true,
      prompt: action.prompt,
      questionCount: questions.length,
      choices: choiceLabels,
      defaultChoice: action.defaultChoice,
      recommendedChoice: action.recommendedChoice,
      allowFreeform: action.allowFreeform ?? true,
      reason: action.reason
    }
  };
}

async function enterPlanMode(action: Extract<ToolAction, { type: "plan.enter" }>, context: LocalToolContext): Promise<ToolResult> {
  const content = [
    "Planning mode is active.",
    action.objective ? `Objective: ${action.objective}` : undefined,
    action.reason ? `Reason: ${action.reason}` : undefined,
    "Inspect the workspace and prepare a concrete plan before editing files."
  ].filter(Boolean).join("\n");

  return {
    action: action.type,
    status: "success",
    summary: action.objective ? `Entered plan mode: ${action.objective}` : "Entered plan mode",
    content,
    data: {
      planningMode: true,
      objective: action.objective,
      reason: action.reason,
      sessionId: context.sessionId,
      taskId: context.taskId
    },
    metadata: {
      interaction: "plan_mode",
      planningMode: true,
      objective: action.objective,
      reason: action.reason
    }
  };
}

async function exitPlanMode(action: Extract<ToolAction, { type: "plan.exit" }>, context: LocalToolContext): Promise<ToolResult> {
  const content = [
    action.summary ? `Summary: ${action.summary}` : undefined,
    "Plan submitted for approval.",
    "",
    action.plan,
    action.allowedPrompts?.length ? "" : undefined,
    action.allowedPrompts?.length ? "Requested implementation permissions:" : undefined,
    ...(action.allowedPrompts ?? []).map((prompt) => `- ${prompt.tool}: ${prompt.prompt}`)
  ].filter((line): line is string => line !== undefined).join("\n");

  return {
    action: action.type,
    status: "partial",
    summary: action.summary ?? "Waiting for plan approval",
    content,
    recoverable: true,
    recoverySuggestion: "Wait for the user to approve or revise the plan before making implementation edits.",
    data: {
      plan: action.plan,
      summary: action.summary,
      ready: action.ready ?? true,
      allowedPrompts: action.allowedPrompts,
      sessionId: context.sessionId,
      taskId: context.taskId
    },
    metadata: {
      interaction: "plan_approval",
      requiresUserInput: true,
      readyForApproval: action.ready ?? true,
      summary: action.summary,
      planBytes: Buffer.byteLength(action.plan, "utf8"),
      allowedPrompts: action.allowedPrompts
    }
  };
}

async function runTaskCreate(action: Extract<ToolAction, { type: "task.create" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.create is only available within a Swarm runtime session");
  }
  return context.taskControl.create(action, taskControlToolContext(context));
}

async function runTaskUpdate(action: Extract<ToolAction, { type: "task.update" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.update is only available within a Swarm runtime session");
  }
  return context.taskControl.update(action, taskControlToolContext(context));
}

async function runTaskGet(action: Extract<ToolAction, { type: "task.get" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.get is only available within a Swarm runtime session");
  }
  return context.taskControl.get(action, taskControlToolContext(context));
}

async function runTaskList(action: Extract<ToolAction, { type: "task.list" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.list is only available within a Swarm runtime session");
  }
  return context.taskControl.list(action, taskControlToolContext(context));
}

async function runTaskOutput(action: Extract<ToolAction, { type: "task.output" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.output is only available within a Swarm runtime session");
  }
  return context.taskControl.output(action, taskControlToolContext(context));
}

async function runTaskStop(action: Extract<ToolAction, { type: "task.stop" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.taskControl) {
    throw new Error("task.stop is only available within a Swarm runtime session");
  }
  return context.taskControl.stop(action, taskControlToolContext(context));
}

async function enterWorktree(action: Extract<ToolAction, { type: "worktree.enter" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.worktreeControl) {
    throw new Error("worktree.enter is only available within a Swarm runtime session");
  }
  return context.worktreeControl.enter(action, worktreeControlToolContext(context));
}

async function exitWorktree(action: Extract<ToolAction, { type: "worktree.exit" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.worktreeControl) {
    throw new Error("worktree.exit is only available within a Swarm runtime session");
  }
  return context.worktreeControl.exit(action, worktreeControlToolContext(context));
}

async function writeBlackboard(action: Extract<ToolAction, { type: "blackboard.write" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("Shared facts are only available inside a Swarm runtime session");
  }
  const entry = await context.blackboard.write(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `Saved shared fact ${entry.key}`,
    content: renderBlackboardEntries([entry]),
    data: { entry }
  };
}

async function readBlackboard(action: Extract<ToolAction, { type: "blackboard.read" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("Shared facts are only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.read(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `Read ${sharedFactCount(entries.length)}`,
    content: renderBlackboardEntries(entries),
    data: { entries }
  };
}

async function searchBlackboard(action: Extract<ToolAction, { type: "blackboard.search" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("Shared facts are only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.search(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `Found ${sharedFactCount(entries.length)}`,
    content: renderBlackboardEntries(entries),
    data: { entries }
  };
}

async function listBlackboard(action: Extract<ToolAction, { type: "blackboard.list" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("Shared facts are only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.list(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `Listed ${sharedFactCount(entries.length)}`,
    content: renderBlackboardEntries(entries),
    data: { entries }
  };
}

function blackboardToolContext(context: LocalToolContext): {
  sessionId?: string;
  blackboardSessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: import("../protocol/types.js").AgentAddress;
} {
  return {
    sessionId: context.sessionId,
    blackboardSessionId: context.blackboardSessionId,
    taskId: context.taskId,
    attempt: context.attempt,
    agent: context.agent
  };
}

function agentControlToolContext(context: LocalToolContext): {
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: import("../protocol/types.js").AgentAddress;
} {
  return {
    sessionId: context.sessionId,
    taskId: context.taskId,
    attempt: context.attempt,
    agent: context.agent
  };
}

function taskControlToolContext(context: LocalToolContext): {
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: import("../protocol/types.js").AgentAddress;
} {
  return {
    sessionId: context.sessionId,
    taskId: context.taskId,
    attempt: context.attempt,
    agent: context.agent
  };
}

function worktreeControlToolContext(context: LocalToolContext): {
  workspace: string;
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: import("../protocol/types.js").AgentAddress;
} {
  return {
    workspace: context.workspace,
    sessionId: context.sessionId,
    taskId: context.taskId,
    attempt: context.attempt,
    agent: context.agent
  };
}

function runtimeControlToolContext(context: LocalToolContext): {
  workspace: string;
  sessionId?: string;
  taskId?: string;
  attempt?: number;
  agent?: import("../protocol/types.js").AgentAddress;
} {
  return {
    workspace: context.workspace,
    sessionId: context.sessionId,
    taskId: context.taskId,
    attempt: context.attempt,
    agent: context.agent
  };
}

async function sendAgentMessage(action: Extract<ToolAction, { type: "agent.message" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.runtimeControl?.sendAgentMessage) {
    return {
      action: action.type,
      status: "failed",
      summary: "agent.message requires the Swarm runtime mailbox adapter",
      errorCode: "RUNTIME_CONTROL_UNAVAILABLE",
      recoverable: true,
      recoverySuggestion: "Run agent.message from an active Swarm runtime session, or use agent.list/agent.continue when mailbox delivery is unavailable."
    };
  }
  return context.runtimeControl.sendAgentMessage(action, runtimeControlToolContext(context));
}

async function runtimeSleep(action: Extract<ToolAction, { type: "runtime.sleep" }>): Promise<ToolResult> {
  const durationMs = Math.floor(action.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return {
      action: action.type,
      status: "failed",
      summary: "runtime.sleep requires a non-negative duration_ms",
      errorCode: "SLEEP_DURATION_INVALID",
      recoverable: true,
      recoverySuggestion: "Retry with duration_ms between 0 and 30000."
    };
  }
  const cappedMs = Math.min(durationMs, 30_000);
  const startedAt = Date.now();
  if (cappedMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, cappedMs));
  }
  const elapsedMs = Date.now() - startedAt;
  return {
    action: action.type,
    status: "success",
    summary: `Waited ${elapsedMs} ms`,
    content: [
      `Waited: ${elapsedMs} ms`,
      action.reason ? `Reason: ${action.reason}` : undefined,
      durationMs !== cappedMs ? `Requested ${durationMs} ms was capped at ${cappedMs} ms.` : undefined
    ].filter(Boolean).join("\n"),
    data: { requested_ms: durationMs, waited_ms: elapsedMs, capped: durationMs !== cappedMs, reason: action.reason },
    metadata: { requested_ms: durationMs, waited_ms: elapsedMs, capped: durationMs !== cappedMs }
  };
}

async function structuredOutput(action: Extract<ToolAction, { type: "structured.output" }>, context: LocalToolContext): Promise<ToolResult> {
  const validationError = validateStructuredOutputValue(action.value, action.schema);
  if (validationError) {
    return {
      action: action.type,
      status: "failed",
      summary: `structured.output schema mismatch: ${validationError}`,
      errorCode: "STRUCTURED_OUTPUT_SCHEMA_MISMATCH",
      recoverable: true,
      recoverySuggestion: "Return JSON matching the requested schema, or omit schema when no schema contract is active.",
      data: { value: action.value, schema: action.schema, error: validationError }
    };
  }
  if (context.runtimeControl?.recordStructuredOutput) {
    return context.runtimeControl.recordStructuredOutput(action, runtimeControlToolContext(context));
  }
  if (!context.runtimeControl?.structuredOutputEnabled) {
    return {
      action: action.type,
      status: "failed",
      summary: "structured.output is only available in headless or schema-enabled runs",
      errorCode: "STRUCTURED_OUTPUT_NOT_ENABLED",
      recoverable: true,
      recoverySuggestion: "Use a normal final response in interactive chat, or enable a headless/schema output contract for structured.output.",
      data: { value: action.value, schema: action.schema }
    };
  }
  return {
    action: action.type,
    status: "success",
    summary: `Structured output accepted${action.label ? `: ${action.label}` : ""}`,
    content: JSON.stringify(action.value, null, 2),
    data: { value: action.value, schema: action.schema, label: action.label, final: action.final === true },
    metadata: {
      label: action.label,
      final: action.final === true,
      schema_validated: Boolean(action.schema)
    }
  };
}

async function replMode(action: Extract<ToolAction, { type: "repl.mode" }>, context: LocalToolContext): Promise<ToolResult> {
  if (context.runtimeControl?.replMode) {
    return context.runtimeControl.replMode(action, runtimeControlToolContext(context));
  }
  const mode = action.mode ?? "interactive";
  return {
    action: action.type,
    status: "success",
    summary: `REPL mode guidance: ${mode}`,
    content: [
      `Mode: ${mode}`,
      "Swarm does not create a second REPL state machine for this tool.",
      "Interactive chat keeps normal tool visibility.",
      "Headless/schema runs may expose structured.output when a runtime output contract enables it.",
      "Use ToolSearch to inspect currently visible tools."
    ].join("\n"),
    data: {
      mode,
      structured_output_available: context.runtimeControl?.structuredOutputEnabled === true,
      primitive_tools_internal: true,
      guidance: "Use normal chat for interactive replies; use structured.output only in schema-enabled headless runs."
    },
    metadata: { mode, structured_output_available: context.runtimeControl?.structuredOutputEnabled === true }
  };
}

function designOnlyAutomationTool(action: Extract<ToolAction, {
  type: "schedule.create" | "schedule.list" | "schedule.delete" | "remote.trigger" | "team.create" | "team.delete";
}>): ToolResult {
  const design = automationDesignGuidance(action);
  return {
    action: action.type,
    status: "failed",
    summary: `${action.type} is design-only in this runtime`,
    content: [
      `${design.title}: not available in this Swarm runtime.`,
      design.reason,
      `Current alternative: ${design.alternative}`,
      `Required runtime support: ${design.requiredSupport}`
    ].join("\n"),
    errorCode: "DESIGN_ONLY_TOOL",
    retryable: false,
    recoverable: true,
    recoverySuggestion: design.alternative,
    data: {
      availability: "design_only",
      action,
      required_runtime_support: design.requiredSupport,
      rationale: design.reason
    },
    metadata: {
      availability: "design_only",
      exact_id_required: action.type === "schedule.delete" || action.type === "team.delete"
    }
  };
}

function automationDesignGuidance(action: Extract<ToolAction, {
  type: "schedule.create" | "schedule.list" | "schedule.delete" | "remote.trigger" | "team.create" | "team.delete";
}>): { title: string; reason: string; alternative: string; requiredSupport: string } {
  switch (action.type) {
    case "schedule.create":
      return {
        title: "Scheduled task creation",
        reason: "src/runtime/scheduler.ts schedules in-memory task dependencies; it is not a durable cron daemon or persisted schedule store.",
        alternative: "Use task.create for tracked work now, or run the CLI from an external scheduler until Swarm has a durable schedule store.",
        requiredSupport: "durable schedule storage, cron validation, wake loop, ownership, audit records, and deletion by exact id"
      };
    case "schedule.list":
      return {
        title: "Scheduled task listing",
        reason: "There is no authoritative durable schedule inventory to list.",
        alternative: "Use task.list for current session tasks and external scheduler tooling for actual cron inventory.",
        requiredSupport: "durable schedule storage and an active schedule index"
      };
    case "schedule.delete":
      return {
        title: "Scheduled task deletion",
        reason: "There is no Swarm-owned durable schedule store, so deleting an id would be misleading.",
        alternative: "Delete the job in the external scheduler that owns it, or keep this as a dry-run design request.",
        requiredSupport: "exact-id schedule records, audit log, ownership checks, and permission-gated deletion"
      };
    case "remote.trigger":
      return {
        title: "Remote trigger",
        reason: "No explicit remote endpoint configuration or credential bridge is available to this local tool.",
        alternative: "Use mcp.call for configured MCP integrations, or configure an explicit remote endpoint before retrying.",
        requiredSupport: "explicit endpoint registry, auth recovery flow, secret-safe config, and audited remote execution"
      };
    case "team.create":
      return {
        title: "Team creation",
        reason: "Swarm already has agent.delegate and task.create; adding a separate team store would duplicate runtime state.",
        alternative: "Use task.create plus agent.delegate with roles/file_scope to compose a team from existing primitives.",
        requiredSupport: "team projection over existing tasks/workers, not a second team database"
      };
    case "team.delete":
      return {
        title: "Team deletion",
        reason: "No first-class team projection exists yet, and deletion must be exact-id scoped and auditable.",
        alternative: "Use task.stop or agent.stop for current workers/tasks, and avoid deleting unrelated runtime state.",
        requiredSupport: "team projection ids, audit log, exact-id deletion, and permission gating"
      };
  }
}

function renderBlackboardEntries(entries: import("../protocol/types.js").BlackboardEntry[]): string {
  if (entries.length === 0) {
    return "(no shared facts)";
  }
  return entries.map((entry) => [
    `${entry.entry_id} ${entry.key} [${entry.type}] v${entry.version}`,
    `created_by=${entry.created_by.agent_id ?? entry.created_by.role ?? entry.created_by.capability ?? "unknown"} visibility=${entry.visibility} tags=${(entry.tags ?? []).join(",") || "-"}`,
    JSON.stringify(entry.value, null, 2)
  ].join("\n")).join("\n\n");
}

function sharedFactCount(count: number): string {
  return `${count} shared fact${count === 1 ? "" : "s"}`;
}

function permissionCheck(check: () => string): { allowed: boolean; reason?: string } {
  try {
    check();
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function fsFailureResult(
  action: ToolAction["type"],
  resolved: string,
  requestedPath: string,
  context: LocalToolContext,
  message: string,
  error: NodeJS.ErrnoException,
  errorCode: string
): ToolResult {
  return {
    action,
    status: "failed",
    summary: `${message}: ${displayPath(resolved, context.workspace)}`,
    errors: [error.message],
    errorCode,
    retryable: false,
    recoverable: errorCode === "FS_NOT_FOUND",
    recoverySuggestion: recoverySuggestionForToolFailure(action, errorCode, error.message),
    data: {
      path: displayPath(resolved, context.workspace),
      requestedPath
    }
  };
}

function parseJsonWithContext(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${reason}`);
  }
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") {
    return root;
  }
  const tokens = jsonPointerTokens(pointer);
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(token, current.length, false);
      current = current[index];
      continue;
    }
    if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token];
      continue;
    }
    throw new Error(`JSON pointer not found: ${pointer}`);
  }
  return current;
}

function applyJsonEdit(root: unknown, pointer: string, operation: "set" | "delete" | "merge", value: unknown): void {
  const tokens = jsonPointerTokens(pointer);
  if (tokens.length === 0) {
    throw new Error("json.edit cannot replace the document root; use file.write for complete replacement");
  }
  const key = tokens[tokens.length - 1];
  const parent = tokens.slice(0, -1).reduce((current, token) => {
    if (Array.isArray(current)) {
      return current[parseArrayIndex(token, current.length, false)];
    }
    if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new Error(`JSON pointer parent not found: ${pointer}`);
      }
      return current[token];
    }
    throw new Error(`JSON pointer parent is not an object or array: ${pointer}`);
  }, root);

  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, operation === "set");
    if (operation === "delete") {
      parent.splice(index, 1);
    } else if (operation === "merge") {
      parent[index] = mergeJsonValues(parent[index], value);
    } else {
      parent[index] = value;
    }
    return;
  }
  if (!isRecord(parent)) {
    throw new Error(`JSON pointer parent is not an object or array: ${pointer}`);
  }
  if (operation === "delete") {
    if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error(`JSON pointer not found: ${pointer}`);
    }
    delete parent[key];
  } else if (operation === "merge") {
    parent[key] = mergeJsonValues(parent[key], value);
  } else {
    parent[key] = value;
  }
}

function mergeJsonValues(existing: unknown, value: unknown): unknown {
  if (!isRecord(existing) || !isRecord(value)) {
    return value;
  }
  return { ...existing, ...value };
}

function jsonPointerTokens(pointer: string): string[] {
  if (!pointer || pointer === "/") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON pointer must start with /: ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parseArrayIndex(token: string, length: number, allowAppend: boolean): number {
  if (allowAppend && token === "-") {
    return length;
  }
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new Error(`JSON array index out of range: ${token}`);
  }
  return index;
}

function createNotebookCell(cellType: "code" | "markdown", source: string): Record<string, unknown> {
  return cellType === "code"
    ? {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: notebookSourceLines(source)
      }
    : {
        cell_type: "markdown",
        metadata: {},
        source: notebookSourceLines(source)
      };
}

function notebookSourceLines(source: string): string[] {
  if (!source) {
    return [];
  }
  const lines = source.split(/\r?\n/);
  return lines.map((line, index) => index < lines.length - 1 ? `${line}\n` : line);
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function endsWithLineEnding(content: string): boolean {
  return content.endsWith("\n") || content.endsWith("\r");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SafeConfigSetting = {
  path: string[];
  type: "boolean" | "number" | "string" | "string[]";
  description: string;
  options?: string[];
  min?: number;
  max?: number;
};

const SAFE_CONFIG_SETTINGS: Record<string, SafeConfigSetting> = {
  "ui.theme": {
    path: ["ui", "theme"],
    type: "string",
    description: "Terminal UI theme.",
    options: ["default"]
  },
  "tools.webSearch": {
    path: ["tools", "webSearch"],
    type: "boolean",
    description: "Enable web.search and web.fetch tools."
  },
  "tools.directWrite": {
    path: ["tools", "directWrite"],
    type: "boolean",
    description: "Enable direct local file write/edit tools."
  },
  "permissions.defaultMode": {
    path: ["permissions", "defaultMode"],
    type: "string",
    description: "Default tool permission mode.",
    options: ["ask", "auto-edit", "full-auto", "yolo"]
  },
  "permissions.additionalDirectories": {
    path: ["permissions", "additionalDirectories"],
    type: "string[]",
    description: "Additional read roots for local file inspection."
  },
  "runtime.maxAgents": {
    path: ["runtime", "maxAgents"],
    type: "number",
    description: "Maximum local Swarm agents.",
    min: 1,
    max: 64
  },
  "runtime.maxParallelTasks": {
    path: ["runtime", "maxParallelTasks"],
    type: "number",
    description: "Maximum parallel task count.",
    min: 1,
    max: 64
  },
  "runtime.taskTimeoutMs": {
    path: ["runtime", "taskTimeoutMs"],
    type: "number",
    description: "Default task timeout in milliseconds.",
    min: 1000,
    max: 86_400_000
  },
  "extensions.skills.enabled": {
    path: ["extensions", "skills", "enabled"],
    type: "boolean",
    description: "Enable Agent Skills."
  },
  "extensions.skills.loadProjectSkills": {
    path: ["extensions", "skills", "loadProjectSkills"],
    type: "string",
    description: "Project skill loading policy.",
    options: ["never", "trustedWorkspaces", "always"]
  },
  "extensions.skills.roots": {
    path: ["extensions", "skills", "roots"],
    type: "string[]",
    description: "Additional trusted skill roots."
  },
  "extensions.skills.maxSkills": {
    path: ["extensions", "skills", "maxSkills"],
    type: "number",
    description: "Maximum skills loaded into the capability catalog.",
    min: 1,
    max: 500
  },
  "extensions.commands.enabled": {
    path: ["extensions", "commands", "enabled"],
    type: "boolean",
    description: "Enable custom slash commands."
  },
  "extensions.mcp.enabled": {
    path: ["extensions", "mcp", "enabled"],
    type: "boolean",
    description: "Enable MCP client support."
  },
  "extensions.mcp.exposeGatewayServer": {
    path: ["extensions", "mcp", "exposeGatewayServer"],
    type: "boolean",
    description: "Expose Swarm gateway MCP server."
  },
  "extensions.plugins.enabled": {
    path: ["extensions", "plugins", "enabled"],
    type: "boolean",
    description: "Enable plugins."
  }
};

function configValueInput(value: unknown): string | number | boolean | null {
  if (value === undefined) {
    throw new Error("config.set requires value");
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error("config.set value must be string, number, boolean, or null");
}

function configGet(action: Extract<ToolAction, { type: "config.get" }>, context: LocalToolContext): ToolResult {
  const setting = action.setting?.trim();
  if (!setting) {
    const rows = Object.entries(SAFE_CONFIG_SETTINGS).map(([key, config]) => ({
      setting: key,
      value: getNestedSetting(context.settings, config.path),
      type: config.type,
      description: config.description,
      options: config.options
    }));
    return {
      action: "config.get",
      status: "success",
      summary: `config.get listed ${rows.length} safe settings`,
      content: rows.map((row) => `${row.setting} = ${formatConfigValue(row.value)} (${row.description})`).join("\n"),
      data: {
        settings: rows,
        secret_safe: true,
        omitted: ["providers", "providerApiKeys", "primaryApiKey", "headers", "env", "tokens", "credentials"]
      }
    };
  }
  const config = SAFE_CONFIG_SETTINGS[setting];
  if (!config) {
    return unknownConfigSetting(setting);
  }
  const value = getNestedSetting(context.settings, config.path);
  return {
    action: "config.get",
    status: "success",
    summary: `${setting} = ${formatConfigValue(value)}`,
    content: `${setting} = ${formatConfigValue(value)}\n${config.description}`,
    data: {
      setting,
      value,
      type: config.type,
      description: config.description,
      options: config.options,
      secret_safe: true
    }
  };
}

function configSet(action: Extract<ToolAction, { type: "config.set" }>, context: LocalToolContext): ToolResult {
  const setting = action.setting.trim();
  const config = SAFE_CONFIG_SETTINGS[setting];
  if (!config) {
    return unknownConfigSetting(setting);
  }
  const nextValue = coerceConfigValue(setting, action.value, config);
  const currentSettings = loadSwarmSettings(context.workspace);
  const previousValue = getNestedSetting(currentSettings, config.path);
  const nextSettings = setNestedSetting(currentSettings, config.path, nextValue) as SwarmSettings;
  saveSwarmSettings(nextSettings);
  Object.assign(context.settings, nextSettings);
  return {
    action: "config.set",
    status: "success",
    summary: `config.set updated ${setting}`,
    content: [
      `Setting: ${setting}`,
      `Previous: ${formatConfigValue(previousValue)}`,
      `New: ${formatConfigValue(nextValue)}`
    ].join("\n"),
    data: {
      setting,
      previousValue,
      newValue: nextValue,
      secret_safe: true
    }
  };
}

function unknownConfigSetting(setting: string): ToolResult {
  return {
    action: "config.get",
    status: "failed",
    summary: `Unknown or unsafe config setting: ${setting}`,
    errors: [`${setting} is not in the safe settings allowlist.`],
    errorCode: "CONFIG_SETTING_UNSUPPORTED",
    recoverable: true,
    retryable: false,
    recoverySuggestion: `Call config.get without a setting to list safe settings. Secrets, provider credentials, env, headers, and API keys are intentionally unavailable.`,
    data: {
      setting,
      supported: Object.keys(SAFE_CONFIG_SETTINGS).sort(),
      secret_safe: true
    }
  };
}

function getNestedSetting(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setNestedSetting(value: unknown, path: string[], nextValue: unknown): unknown {
  const root = isRecord(value) ? { ...value } : {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const child = current[segment];
    current[segment] = isRecord(child) ? { ...child } : {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = nextValue;
  return root;
}

function coerceConfigValue(setting: string, value: string | number | boolean | null, config: SafeConfigSetting): unknown {
  if (value === null) {
    throw new Error(`${setting} cannot be set to null`);
  }
  if (config.type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    throw new Error(`${setting} requires true or false`);
  }
  if (config.type === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${setting} requires a number`);
    }
    const next = Math.floor(parsed);
    if (config.min !== undefined && next < config.min) {
      throw new Error(`${setting} must be >= ${config.min}`);
    }
    if (config.max !== undefined && next > config.max) {
      throw new Error(`${setting} must be <= ${config.max}`);
    }
    return next;
  }
  if (config.type === "string[]") {
    if (typeof value !== "string") {
      throw new Error(`${setting} requires a comma-separated string`);
    }
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  const text = String(value);
  if (config.options?.length && !config.options.includes(text)) {
    throw new Error(`${setting} must be one of: ${config.options.join(", ")}`);
  }
  return text;
}

function formatConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(String).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createSimpleDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const maxChangedLines = 160;
  const lines = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  let emitted = 0;
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] === afterLines[index]) {
      continue;
    }
    if (emitted >= maxChangedLines) {
      lines.push(`... diff truncated after ${maxChangedLines} changed lines`);
      break;
    }
    if (beforeLines[index] !== undefined) {
      lines.push(`-${beforeLines[index]}`);
      emitted += 1;
    }
    if (afterLines[index] !== undefined) {
      lines.push(`+${afterLines[index]}`);
      emitted += 1;
    }
  }
  return lines.join("\n");
}

function snapshotKey(path: string, context: LocalToolContext): string {
  return `${context.sessionId ?? "global"}:${resolve(path)}`;
}

async function executeShell(action: Extract<ToolAction, { type: "shell.exec" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("shell.exec requires command");
  }
  const hostValidationError = validateShellCommandForHost(action.command);
  if (hostValidationError) {
    return {
      action: action.type,
      status: "failed",
      summary: hostValidationError,
      content: [`$ ${action.command}`, `ERROR: ${hostValidationError}`].join("\n"),
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: process.platform === "win32"
        ? "Rewrite the command using PowerShell syntax, or explicitly invoke an available shell such as bash/wsl/cmd when that is intentional."
        : "Rewrite the command for the configured host shell."
    };
  }
  const backgroundSuggestion = foregroundBackgroundSuggestion(action.command);
  if (backgroundSuggestion && !action.runInBackground && action.timeoutMs === undefined) {
    return foregroundLongRunningCommandResult(action.type, action.command, backgroundSuggestion);
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(1000, action.timeoutMs ?? 120_000);
  const maxOutputBytes = Math.max(1024, action.maxOutputBytes ?? 200_000);
  if (action.runInBackground) {
    const processRecord = await startBackgroundProcess({
      command: action.command,
      cwd,
      sessionId: context.sessionId,
      taskId: context.taskId,
      description: action.description,
      timeoutMs: action.timeoutMs,
      maxLogBytes: action.maxLogBytes
    });
    return backgroundProcessToolResult(action.type, processRecord, context);
  }
  const result = await runShellCommand(action.command, {
    cwd,
    timeoutMs,
    maxOutputBytes,
    outputPersistence: commandOutputPersistence(action, context)
  });
  return commandToolResult(action, context, cwd, timeoutMs, result);
}

async function executePowerShell(action: Extract<ToolAction, { type: "powershell.exec" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("powershell.exec requires command");
  }
  const backgroundSuggestion = foregroundBackgroundSuggestion(action.command);
  if (backgroundSuggestion && !action.runInBackground && action.timeoutMs === undefined) {
    return foregroundLongRunningCommandResult(action.type, action.command, backgroundSuggestion);
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(1000, action.timeoutMs ?? 120_000);
  const maxOutputBytes = Math.max(1024, action.maxOutputBytes ?? 200_000);
  if (action.runInBackground) {
    const processRecord = await startBackgroundProcess({
      command: action.command,
      cwd,
      sessionId: context.sessionId,
      taskId: context.taskId,
      description: action.description,
      timeoutMs: action.timeoutMs,
      maxLogBytes: action.maxLogBytes,
      shell: "powershell"
    });
    return backgroundProcessToolResult(action.type, processRecord, context);
  }
  const result = await runPowerShellCommand(action.command, {
    cwd,
    timeoutMs,
    maxOutputBytes,
    outputPersistence: commandOutputPersistence(action, context)
  });
  return commandToolResult(action, context, cwd, timeoutMs, result);
}

function commandToolResult(
  action: Extract<ToolAction, { type: "shell.exec" | "powershell.exec" }>,
  context: LocalToolContext,
  cwd: string,
  timeoutMs: number,
  result: ShellCommandResult
): ToolResult {
  if (result.error) {
    const content = [`$ ${action.command}`, `ERROR: ${result.error}`].join("\n");
    return {
      action: action.type,
      status: "failed",
      summary: `command failed: ${result.error}`,
      content,
      metadata: {
        cwd: displayPath(cwd, context.workspace),
        error: result.error,
        timeoutMs,
        persistedOutputPath: result.persistedOutputPath,
        persistedOutputSize: result.persistedOutputSize,
        preview: result.preview,
        hasMore: result.hasMore
      },
      outputRef: result.persistedOutputPath,
      errorCode: classifyProcessError(result),
      retryable: isRetryableProcessError(result),
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, classifyProcessError(result), result.error, result)
    };
  }

  const content = [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  const semantic = typeof result.exitCode === "number" && !result.timedOut
    ? interpretCommandResult(action.type === "powershell.exec" ? "powershell" : "shell", action.command, result.exitCode)
    : undefined;
  const succeeded = !result.timedOut && result.exitCode !== null && (semantic ? !semantic.isError : result.exitCode === 0);
  const errorCode = succeeded ? undefined : classifyProcessError(result);
  return {
    action: action.type,
    status: succeeded ? "success" : "failed",
    summary: result.timedOut
      ? `command timed out after ${timeoutMs}ms`
      : semantic?.message ?? `command exited ${result.exitCode ?? result.signal ?? "unknown"}`,
    content,
    outputRef: result.persistedOutputPath,
    errorCode,
    retryable: succeeded ? undefined : isRetryableProcessError(result),
    recoverable: succeeded ? undefined : true,
    recoverySuggestion: succeeded ? undefined : recoverySuggestionForToolFailure(action.type, errorCode, content, result),
    metadata: {
      cwd: displayPath(cwd, context.workspace),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      timeoutMs,
      truncated: result.truncated,
      persistedOutputPath: result.persistedOutputPath,
      persistedOutputSize: result.persistedOutputSize,
      preview: result.preview,
      hasMore: result.hasMore,
      commandSemantic: semantic?.message
    }
  };
}

function foregroundBackgroundSuggestion(command: string): string | undefined {
  const normalized = command.trim();
  if (!normalized) {
    return undefined;
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/i.test(normalized)) {
    return "This looks like a dev server or watcher. Run it with run_in_background=true or ProcessStart, then inspect logs with process.tail/process.grep.";
  }
  if (/\b(vite|next\s+dev|webpack(?:-dev-server)?|nodemon|tsc\s+-w|jest\s+--watch|tail\s+-f)\b/i.test(normalized)) {
    return "This looks like a long-running foreground command. Use run_in_background=true or ProcessStart so the TUI can keep working.";
  }
  if (/\bwhile\s*\(\s*\$?true\s*\)|\bwhile\s+true\b/i.test(normalized)) {
    return "This looks like a persistent loop. Use run_in_background=true or ProcessStart, then stop it with process.stop when done.";
  }
  return undefined;
}

function foregroundLongRunningCommandResult(action: ToolAction["type"], command: string, suggestion: string): ToolResult {
  return {
    action,
    status: "failed",
    summary: "command appears long-running; start it in the background",
    content: [`$ ${command}`, `ERROR: ${suggestion}`].join("\n"),
    errorCode: "INVALID_INPUT",
    retryable: false,
    recoverable: true,
    recoverySuggestion: suggestion
  };
}

async function executeExec(action: Extract<ToolAction, { type: "exec" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("exec requires command");
  }
  const shellAction: Extract<ToolAction, { type: "shell.exec" }> = {
    type: "shell.exec",
    command: action.command,
    cwd: action.cwd,
    timeoutMs: action.timeoutMs,
    maxOutputBytes: action.maxOutputBytes,
    runInBackground: action.runInBackground,
    description: action.description,
    maxLogBytes: action.maxLogBytes
  };
  const result = await executeShell(shellAction, context);
  return {
    ...result,
    action: action.type,
    summary: result.summary.replace(/^command/, "exec command")
  };
}

async function executeProcessStart(action: Extract<ToolAction, { type: "process.start" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("process.start requires command");
  }
  const hostValidationError = validateShellCommandForHost(action.command);
  if (hostValidationError) {
    return {
      action: action.type,
      status: "failed",
      summary: hostValidationError,
      content: [`$ ${action.command}`, `ERROR: ${hostValidationError}`].join("\n"),
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: process.platform === "win32"
        ? "Rewrite the command using PowerShell syntax, or explicitly invoke an available shell such as bash/wsl/cmd when that is intentional."
        : "Rewrite the command for the configured host shell."
    };
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const record = await startBackgroundProcess({
    command: action.command,
    cwd,
    sessionId: context.sessionId,
    taskId: context.taskId,
    description: action.description,
    timeoutMs: action.timeoutMs,
    maxLogBytes: action.maxLogBytes
  });
  return backgroundProcessToolResult(action.type, record, context);
}

async function executeProcessStatus(action: Extract<ToolAction, { type: "process.status" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.processId) {
    const records = await listBackgroundProcesses({ sessionId: action.sessionId ?? context.sessionId, limit: 20 });
    return {
      action: action.type,
      status: "success",
      summary: `listed ${records.length} background process(es)`,
      content: renderProcessList(records, context),
      data: { processes: records }
    };
  }
  const record = await getBackgroundProcess(action.processId, action.sessionId ?? context.sessionId);
  return {
    action: action.type,
    status: record.status === "failed" ? "failed" : "success",
    summary: `process ${record.processId} is ${record.status}`,
    content: renderProcessRecord(record, context),
    outputRef: record.logPath,
    data: { process: record },
    errorCode: record.status === "failed" ? "PROCESS_FAILED" : undefined,
    recoverable: record.status === "failed" ? true : undefined,
    recoverySuggestion: record.status === "failed" ? `Inspect the log with process.tail or file.read: ${record.logPath}` : undefined
  };
}

async function executeProcessList(action: Extract<ToolAction, { type: "process.list" }>, context: LocalToolContext): Promise<ToolResult> {
  const records = await listBackgroundProcesses({
    sessionId: action.sessionId ?? context.sessionId,
    status: action.status,
    limit: action.limit
  });
  return {
    action: action.type,
    status: "success",
    summary: `listed ${records.length} background process(es)`,
    content: renderProcessList(records, context),
    data: { processes: records }
  };
}

async function executeProcessTail(action: Extract<ToolAction, { type: "process.tail" }>, context: LocalToolContext): Promise<ToolResult> {
  const result = await readBackgroundProcessTail({
    processId: action.processId,
    sessionId: action.sessionId ?? context.sessionId,
    lines: action.lines,
    maxBytes: action.maxBytes
  });
  return {
    action: action.type,
    status: result.process.status === "failed" ? "failed" : "success",
    summary: `tail ${result.process.processId}: ${result.process.status}, ${result.bytesTotal} byte(s)`,
    content: [
      renderProcessRecord(result.process, context),
      "",
      result.content || "(no log output yet)"
    ].join("\n"),
    outputRef: result.process.logPath,
    data: {
      process: result.process,
      bytesTotal: result.bytesTotal,
      bytesRead: result.bytesRead,
      truncated: result.truncated,
      persistedOutputPath: result.process.logPath,
      persistedOutputSize: result.bytesTotal,
      hasMore: result.truncated
    },
    errorCode: result.process.status === "failed" ? "PROCESS_FAILED" : undefined,
    recoverable: result.process.status === "failed" ? true : undefined
  };
}

async function executeProcessGrep(action: Extract<ToolAction, { type: "process.grep" }>, context: LocalToolContext): Promise<ToolResult> {
  const result = await grepBackgroundProcessLog({
    processId: action.processId,
    sessionId: action.sessionId ?? context.sessionId,
    pattern: action.pattern,
    maxMatches: action.maxMatches,
    contextLines: action.contextLines
  });
  return {
    action: action.type,
    status: "success",
    summary: `grep ${result.process.processId}: ${result.totalMatches} match(es)`,
    content: [
      renderProcessRecord(result.process, context),
      "",
      result.matches.length ? result.matches.join("\n") : "(no matches)"
    ].join("\n"),
    outputRef: result.process.logPath,
    data: {
      process: result.process,
      matches: result.matches,
      totalMatches: result.totalMatches,
      truncated: result.truncated,
      persistedOutputPath: result.process.logPath,
      persistedOutputSize: result.bytesTotal,
      hasMore: result.truncated
    }
  };
}

async function executeProcessStop(action: Extract<ToolAction, { type: "process.stop" }>, context: LocalToolContext): Promise<ToolResult> {
  const record = await stopBackgroundProcess(action.processId, action.sessionId ?? context.sessionId);
  return {
    action: action.type,
    status: "success",
    summary: `process ${record.processId} ${record.status}`,
    content: renderProcessRecord(record, context),
    data: { process: record }
  };
}

function backgroundProcessToolResult(action: ToolAction["type"] | string, record: Awaited<ReturnType<typeof startBackgroundProcess>>, context: LocalToolContext): ToolResult {
  return {
    action,
    status: record.status === "failed" ? "failed" : "success",
    summary: record.status === "running"
      ? `background process started: ${record.processId}`
      : `background process ${record.processId} ${record.status}`,
    content: [
      renderProcessRecord(record, context),
      "",
      `Use process.tail with processId=${record.processId} to read recent output.`,
      `Use process.grep to search the log, or process.stop to stop it.`
    ].join("\n"),
    outputRef: record.logPath,
    data: { process: record },
    errorCode: record.status === "failed" ? "PROCESS_START_FAILED" : undefined,
    recoverable: record.status === "failed" ? true : undefined,
    recoverySuggestion: record.status === "failed" ? "Inspect the log path and retry with a corrected command or cwd." : undefined
  };
}

function renderProcessList(records: Awaited<ReturnType<typeof listBackgroundProcesses>>, context: LocalToolContext): string {
  if (records.length === 0) {
    return "No background processes found.";
  }
  return records.map((record) => [
    `${record.processId} [${record.status}] pid=${record.pid ?? "-"}`,
    `  command: ${record.command}`,
    `  cwd: ${displayPath(record.cwd, context.workspace)}`,
    `  log: ${record.logPath}`,
    `  started: ${record.startedAt}${record.endedAt ? ` ended: ${record.endedAt}` : ""}`
  ].join("\n")).join("\n");
}

function renderProcessRecord(record: Awaited<ReturnType<typeof getBackgroundProcess>>, context: LocalToolContext): string {
  return [
    `Process: ${record.processId}`,
    `Status: ${record.status}`,
    `PID: ${record.pid ?? "-"}`,
    `Command: ${record.command}`,
    `CWD: ${displayPath(record.cwd, context.workspace)}`,
    `Log: ${record.logPath}`,
    `Metadata: ${record.metadataPath}`,
    `Started: ${record.startedAt}`,
    record.endedAt ? `Ended: ${record.endedAt}` : undefined,
    record.exitCode !== undefined ? `Exit code: ${record.exitCode}` : undefined,
    record.signal ? `Signal: ${record.signal}` : undefined,
    record.lastError ? `Error: ${record.lastError}` : undefined
  ].filter(Boolean).join("\n");
}

type WebSearchHit = {
  title: string;
  url: string;
  snippet?: string;
};

async function webSearch(action: Extract<ToolAction, { type: "web.search" }>, context: LocalToolContext): Promise<ToolResult> {
  const query = action.query.trim();
  const allowedDomains = normalizeDomains(action.allowed_domains);
  const blockedDomains = normalizeDomains(action.blocked_domains);
  if (!query) {
    return { action: "web.search", status: "success", summary: "web search returned 0 results", data: { query, results: [] } };
  }
  if (allowedDomains.length && blockedDomains.length) {
    return {
      action: "web.search",
      status: "failed",
      summary: "web search cannot use allowed_domains and blocked_domains together",
      errors: ["Specify allowed_domains or blocked_domains, not both."],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, "INVALID_INPUT", "allowed_domains and blocked_domains were both set"),
      data: { query, allowed_domains: allowedDomains, blocked_domains: blockedDomains }
    };
  }

  const startedAt = Date.now();
  let fallbackReason: string | undefined;
  if (context.serverWebSearch) {
    try {
      return await context.serverWebSearch({ ...action, query, allowed_domains: allowedDomains, blocked_domains: blockedDomains });
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  const fallbackErrors: string[] = [];
  const instant = await searchDuckDuckGoInstant(query).catch((error: unknown) => {
    fallbackErrors.push(error instanceof Error ? error.message : String(error));
    return { abstract: "", abstractUrl: "", hits: [] };
  });
  const htmlHits = instant.hits.length >= 5
    ? []
    : await searchDuckDuckGoHtml(query).catch((error: unknown) => {
        fallbackErrors.push(error instanceof Error ? error.message : String(error));
        return [];
      });
  const bingHits = instant.hits.length + htmlHits.length >= 5
    ? []
    : await searchBingHtml(query).catch((error: unknown) => {
        fallbackErrors.push(error instanceof Error ? error.message : String(error));
        return [];
      });
  const hits = filterSearchHits(dedupeSearchHits([...instant.hits, ...htmlHits, ...bingHits]), allowedDomains, blockedDomains).slice(0, 10);
  const durationSeconds = (Date.now() - startedAt) / 1000;
  if (!instant.abstract && hits.length === 0 && fallbackErrors.length) {
    return {
      action: "web.search",
      status: "failed",
      summary: "web search failed before returning results",
      errors: fallbackReason ? [fallbackReason, ...fallbackErrors] : fallbackErrors,
      errorCode: "NETWORK_ERROR",
      retryable: true,
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, "NETWORK_ERROR", fallbackErrors.join("\n")),
      data: {
        query,
        provider: "local-search-fallback",
        durationSeconds,
        fallbackReason,
        fallbackErrors,
        allowed_domains: allowedDomains,
        blocked_domains: blockedDomains
      }
    };
  }
  const content = formatWebSearchContent({
    query,
    abstract: instant.abstract,
    abstractUrl: instant.abstractUrl,
    hits,
    fallbackReason
  });

  return {
    action: "web.search",
    status: "success",
    summary: `web search returned ${hits.length + (instant.abstract ? 1 : 0)} result(s)${fallbackReason ? " using fallback" : ""}`,
    content,
    data: {
      query,
      provider: "local-search-fallback",
      durationSeconds,
      fallbackReason,
      fallbackErrors,
      allowed_domains: allowedDomains,
      blocked_domains: blockedDomains,
      abstract: instant.abstract,
      abstract_url: instant.abstractUrl,
      results: hits
    }
  };
}

async function searchDuckDuckGoInstant(query: string): Promise<{ abstract: string; abstractUrl: string; hits: WebSearchHit[] }> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Web search failed with HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }>;
  };
  const related = flattenDuckDuckGoRelated(json.RelatedTopics ?? [])
    .filter((item) => item.Text || item.FirstURL)
    .map((item) => ({
      title: cleanHtml(item.Text ?? item.FirstURL ?? "Untitled"),
      url: item.FirstURL ?? "",
      snippet: item.Text ? cleanHtml(item.Text) : undefined
    }))
    .filter((item) => isHttpUrl(item.url));
  return {
    abstract: json.AbstractText ?? "",
    abstractUrl: json.AbstractURL ?? "",
    hits: related
  };
}

async function searchDuckDuckGoHtml(query: string): Promise<WebSearchHit[]> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      "user-agent": "SwarmCLI/0.1 web.search"
    }
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search failed with HTTP ${response.status}`);
  }
  const html = await response.text();
  const hits: WebSearchHit[] = [];
  const anchorPattern = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const url = decodeDuckDuckGoUrl(decodeHtmlEntity(match[1] ?? ""));
    if (!isHttpUrl(url)) {
      continue;
    }
    hits.push({
      title: cleanHtml(match[2] ?? url),
      url
    });
  }
  return hits;
}

async function searchBingHtml(query: string): Promise<WebSearchHit[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 SwarmCLI/0.1 web.search"
    }
  });
  if (!response.ok) {
    throw new Error(`Bing HTML search failed with HTTP ${response.status}`);
  }
  const html = await response.text();
  const hits: WebSearchHit[] = [];
  const itemPattern = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const item of html.matchAll(itemPattern)) {
    const block = item[1] ?? "";
    const titleMatch = block.match(/<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!titleMatch) {
      continue;
    }
    const resultUrl = decodeBingUrl(decodeHtmlEntity(titleMatch[1] ?? ""));
    if (!isHttpUrl(resultUrl)) {
      continue;
    }
    const snippetMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({
      title: cleanHtml(titleMatch[2] ?? resultUrl),
      url: resultUrl,
      snippet: snippetMatch ? cleanHtml(snippetMatch[1] ?? "") : undefined
    });
  }
  return hits;
}

function flattenDuckDuckGoRelated(
  topics: Array<{ Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }>
): { Text?: string; FirstURL?: string }[] {
  return topics.flatMap((topic) => topic.Topics?.length ? flattenDuckDuckGoRelated(topic.Topics) : [topic]);
}

function filterSearchHits(hits: WebSearchHit[], allowedDomains: string[], blockedDomains: string[]): WebSearchHit[] {
  return hits.filter((hit) => {
    const host = urlHost(hit.url);
    if (!host) {
      return false;
    }
    if (allowedDomains.length && !allowedDomains.some((domain) => domainMatches(host, domain))) {
      return false;
    }
    return !blockedDomains.some((domain) => domainMatches(host, domain));
  });
}

function dedupeSearchHits(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  const result: WebSearchHit[] = [];
  for (const hit of hits) {
    const key = hit.url.replace(/#.*$/, "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hit);
  }
  return result;
}

function formatWebSearchContent(input: {
  query: string;
  abstract: string;
  abstractUrl: string;
  hits: WebSearchHit[];
  fallbackReason?: string;
}): string {
  const lines = [`Web search results for "${input.query}"`];
  if (input.fallbackReason) {
    lines.push("", `Provider-native web search was unavailable; used local fallback. Reason: ${input.fallbackReason}`);
  }
  if (input.abstract) {
    lines.push("", input.abstract);
    if (input.abstractUrl) {
      lines.push(`Source: ${input.abstractUrl}`);
    }
  }
  if (input.hits.length) {
    lines.push("", "Results:");
    for (const hit of input.hits) {
      lines.push(`- ${hit.title}: ${hit.url}${hit.snippet ? `\n  ${hit.snippet}` : ""}`);
    }
  }
  lines.push("", "Sources:");
  if (input.abstractUrl) {
    lines.push(`- [Abstract](${input.abstractUrl})`);
  }
  for (const hit of input.hits) {
    lines.push(`- [${escapeMarkdownLinkText(hit.title)}](${hit.url})`);
  }
  lines.push("", "REMINDER: Include relevant sources above in the final user response using markdown hyperlinks.");
  return lines.join("\n").trim();
}

function normalizeDomains(value: string[] | undefined): string[] {
  if (!value?.length) {
    return [];
  }
  return [...new Set(value.map(normalizeDomain).filter(Boolean))];
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().replace(/^domain:/i, "");
  if (!trimmed) {
    return "";
  }
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.split("/")[0].toLowerCase().replace(/^www\./, "");
  }
}

function domainMatches(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^www\./, "");
  return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return value;
  }
}

function decodeBingUrl(value: string): string {
  try {
    const url = new URL(value, "https://www.bing.com");
    if (!/(\.|^)bing\.com$/i.test(url.hostname)) {
      return url.href;
    }
    const encoded = url.searchParams.get("u");
    if (!encoded) {
      return url.href;
    }
    if (/^https?:\/\//i.test(encoded)) {
      return decodeURIComponent(encoded);
    }
    const base64 = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const decoded = Buffer.from(base64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : url.href;
  } catch {
    return value;
  }
}

function cleanHtml(value: string): string {
  return decodeHtmlEntity(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function classifyProcessError(result: Pick<ShellCommandResult, "exitCode" | "signal" | "timedOut" | "error">): string {
  if (result.timedOut) {
    return "TIMEOUT";
  }
  if (result.error) {
    return /enoent/i.test(result.error) ? "FS_NOT_FOUND" : "PROCESS_ERROR";
  }
  if (result.signal) {
    return `SIGNAL_${result.signal}`;
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return `EXIT_${result.exitCode}`;
  }
  return "TOOL_FAILED";
}

function isRetryableProcessError(result: Pick<ShellCommandResult, "exitCode" | "timedOut" | "error">): boolean {
  if (result.timedOut) {
    return true;
  }
  if (result.error) {
    return !/enoent|not recognized|not found/i.test(result.error);
  }
  return false;
}

function recoverySuggestionForToolFailure(
  action: ToolAction["type"],
  errorCode: string | undefined,
  detail: string,
  process?: Pick<ShellCommandResult, "exitCode" | "timedOut" | "truncated">
): string {
  if (errorCode === "FS_NOT_FOUND") {
    return "Confirm the path or command exists with file.list, file.glob, git.status, or a shell which/where command, then retry with the resolved path.";
  }
  if (errorCode === "INVALID_INPUT") {
    return "Fix the tool arguments and retry; inspect the target with file.read, file.grep, or the relevant status command first.";
  }
  if (errorCode === "NETWORK_ERROR") {
    return "Retry once, then narrow the URL/domain/query or use a provider-native web search/fetch path if available.";
  }
  if (errorCode === "TIMEOUT" || process?.timedOut) {
    return "Retry with a longer timeout, narrow the command, or use run_in_background=true / process.start for servers, watchers, and long-running polls.";
  }
  if (process?.truncated) {
    return "Use the saved full output or rerun with a narrower command before deciding the fix.";
  }
  if (action === "code.test") {
    return "Read the failing test output, edit the smallest relevant code path, then rerun the same test command.";
  }
  if (action === "shell.exec" && /npm|pnpm|yarn|node|python|pytest|cargo|go test/i.test(detail)) {
    return "Treat this as a verification failure: inspect stderr/stdout, patch the relevant code or dependency issue, then rerun the same command.";
  }
  if (action === "file.edit") {
    return "Re-read the target region and retry with a unique oldText or a precise insert line.";
  }
  return "Inspect the output, adjust the command or inputs, and retry from the current workspace state.";
}

export function webFetchHttpFailureMetadata(status: number, statusText: string): Pick<ToolResult, "errors" | "errorCode" | "retryable" | "recoverable" | "recoverySuggestion"> {
  const errorCode = `HTTP_${status}`;
  return {
    errors: [`HTTP ${status} ${statusText}`],
    errorCode,
    retryable: status >= 500 || status === 429,
    recoverable: true,
    recoverySuggestion: recoverySuggestionForToolFailure("web.fetch", errorCode, `${status} ${statusText}`)
  };
}

async function webFetch(action: Extract<ToolAction, { type: "web.fetch" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.url.trim()) {
    throw new Error("web.fetch requires url");
  }
  const timeoutMs = Math.max(1000, action.timeoutMs ?? 30_000);
  const maxBytes = Math.max(1024, action.maxBytes ?? 500_000);
  const originalUrl = normalizeFetchUrl(action.url);
  if (!originalUrl) {
    return {
      action: "web.fetch",
      status: "failed",
      summary: `web.fetch failed: invalid URL ${action.url}`,
      errors: [`Invalid URL: ${action.url}`],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: "Retry with a valid http(s) URL.",
      metadata: { url: action.url }
    };
  }
  if (originalUrl.username || originalUrl.password) {
    return {
      action: "web.fetch",
      status: "failed",
      summary: "web.fetch refused a URL with embedded credentials",
      errors: ["URLs with username or password are not allowed."],
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: "Remove credentials from the URL, use a public URL, or use an authenticated MCP integration instead.",
      metadata: { url: redactUrlCredentials(originalUrl.href) }
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(originalUrl.href, { signal: controller.signal, redirect: "manual" });
    const redirect = redirectUrlFromResponse(response, originalUrl);
    if (redirect) {
      clearTimeout(timer);
      const permitted = isPermittedWebFetchRedirect(originalUrl, redirect);
      if (!permitted) {
        return {
          action: "web.fetch",
          status: "partial",
          summary: `web.fetch found a cross-host redirect to ${redirect.hostname}`,
          content: [
            "Redirect detected. The redirected host needs a separate explicit fetch.",
            `Original URL: ${redactUrlCredentials(originalUrl.href)}`,
            `Redirect URL: ${redactUrlCredentials(redirect.href)}`,
            `Status: ${response.status} ${response.statusText}`,
            "",
            "Retry web.fetch with the redirect URL if this destination is intended."
          ].join("\n"),
          recoverable: true,
          retryable: true,
          recoverySuggestion: "Retry web.fetch with the redirect URL if the new host is expected, or use web.search/MCP for authenticated content.",
          metadata: {
            url: redactUrlCredentials(originalUrl.href),
            redirectUrl: redactUrlCredentials(redirect.href),
            redirect_cross_host: true,
            status: response.status
          }
        };
      }
      response = await fetch(redirect.href, { signal: controller.signal, redirect: "follow" });
    }
  } catch (error) {
    clearTimeout(timer);
    const reason = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      action: "web.fetch",
      status: "failed",
      summary: `web.fetch failed: ${isTimeout ? "timeout" : reason}`,
      errors: [reason],
      errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      retryable: true,
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, isTimeout ? "TIMEOUT" : "NETWORK_ERROR", reason),
      metadata: {
        url: redactUrlCredentials(originalUrl.href),
        error: reason,
        timedOut: isTimeout
      }
    };
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isText = contentType.includes("text/") || contentType.includes("application/json") || contentType.includes("application/xml") || contentType.includes("application/javascript");

  if (!isText) {
    const status = response.ok ? "success" : "failed";
    const failure = response.ok ? undefined : webFetchHttpFailureMetadata(response.status, response.statusText);
    return {
      action: "web.fetch",
      status,
      summary: `fetched ${redactUrlCredentials(originalUrl.href)} — ${response.status} ${contentType || "unknown content type"} (${response.headers.get("content-length") ?? "?"} bytes, non-text, body not returned)`,
      ...failure,
      data: {
        url: redactUrlCredentials(originalUrl.href),
        finalUrl: response.url && response.url !== originalUrl.href ? redactUrlCredentials(response.url) : undefined,
        status: response.status,
        contentType,
        contentLength: response.headers.get("content-length"),
        source: webFetchSourceMetadata(originalUrl.href, response)
      }
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const truncated = buffer.length > maxBytes;
  const content = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : buffer.toString("utf8");
  const displayContent = action.prompt ? webFetchPromptedContent(content, action.prompt, originalUrl.href) : content;
  const persisted = truncated && context.sessionId
    ? await writeTaskOutput({
        sessionId: context.sessionId,
        taskId: context.taskId ?? `web.fetch.${safeTaskKey(originalUrl.hostname)}`,
        attempt: context.attempt ?? 0,
        content: buffer.toString("utf8")
      })
    : undefined;

  return {
    action: "web.fetch",
    status: response.ok ? "success" : "failed",
    summary: `fetched ${redactUrlCredentials(originalUrl.href)} — ${response.status} ${contentType || "unknown content type"}, ${buffer.length} bytes${truncated ? " (truncated)" : ""}`,
    content: persisted ? webFetchTruncatedContent(displayContent, persisted.path, buffer.length, maxBytes) : displayContent,
    outputRef: persisted?.path,
    ...(response.ok ? undefined : webFetchHttpFailureMetadata(response.status, response.statusText)),
    data: {
      url: redactUrlCredentials(originalUrl.href),
      finalUrl: response.url && response.url !== originalUrl.href ? redactUrlCredentials(response.url) : undefined,
      status: response.status,
      contentType,
      bytes: buffer.length,
      prompt: action.prompt,
      truncated,
      outputRef: persisted,
      source: webFetchSourceMetadata(originalUrl.href, response)
    }
  };
}

function normalizeFetchUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function redirectUrlFromResponse(response: Response, originalUrl: URL): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return undefined;
  }
  const location = response.headers.get("location");
  if (!location) {
    return undefined;
  }
  try {
    const redirect = new URL(location, originalUrl.href);
    return redirect.protocol === "http:" || redirect.protocol === "https:" ? redirect : undefined;
  } catch {
    return undefined;
  }
}

function isPermittedWebFetchRedirect(originalUrl: URL, redirectUrl: URL): boolean {
  const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");
  return originalUrl.protocol === redirectUrl.protocol
    && originalUrl.port === redirectUrl.port
    && !redirectUrl.username
    && !redirectUrl.password
    && stripWww(originalUrl.hostname) === stripWww(redirectUrl.hostname);
}

function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return value.replace(/\/\/[^/@]+@/g, "//[redacted]@");
  }
}

function webFetchSourceMetadata(originalUrl: string, response: Response): Record<string, unknown> {
  return {
    original_url: redactUrlCredentials(originalUrl),
    final_url: response.url ? redactUrlCredentials(response.url) : undefined,
    status: response.status,
    content_type: response.headers.get("content-type") ?? undefined,
    etag: response.headers.get("etag") ?? undefined,
    last_modified: response.headers.get("last-modified") ?? undefined,
    fetched_at: new Date().toISOString()
  };
}

function webFetchTruncatedContent(content: string, outputRef: string, totalBytes: number, maxBytes: number): string {
  return [
    content,
    "",
    `[web.fetch truncated to ${maxBytes} bytes from ${totalBytes} bytes. Full content saved to ${outputRef}]`
  ].join("\n");
}

function safeTaskKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "output";
}

function webFetchPromptedContent(content: string, prompt: string, url: string): string {
  return [
    `URL: ${url}`,
    `Prompt: ${prompt}`,
    "",
    "Fetched content:",
    content
  ].join("\n");
}

type LocalMcpServer = ReturnType<NonNullable<LocalToolContext["externalContext"]>["listMcpServers"]>[number];

type CompactMcpServer = {
  id: string;
  status: string;
  transport?: string;
  trust?: string;
  exposeResources?: boolean;
  exposeTools?: boolean;
  toolCount?: number;
  resourceCount?: number;
  lastError?: string;
};

type CompactMcpResource = {
  server?: string;
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  value?: string;
};

function listMcpResources(action: Extract<ToolAction, { type: "mcp.resources" }>, context: LocalToolContext): ToolResult {
  if (!context.externalContext) {
    return externalContextUnavailable(action.type);
  }
  const servers = context.externalContext.listMcpServers();
  const server = resolveMcpServer(action.server, servers);
  if (server.status === "failed") {
    return server;
  }
  const selected = server.data.servers;
  const resources = selected.flatMap((item) => {
    if (item.status !== "connected") {
      return [];
    }
    return context.externalContext?.listMcpResources(item.id).map((resource) => ({
      ...compactMcpResource(resource),
      server: item.id
    })) ?? [];
  });
  const limit = Math.max(1, Math.min(action.limit ?? 50, 200));
  const visible = resources.slice(0, limit);
  const skippedServers = selected.filter((item) => item.status !== "connected");
  return {
    action: action.type,
    status: skippedServers.length && visible.length === 0 ? "partial" : "success",
    summary: visible.length
      ? `mcp.resources returned ${visible.length}${resources.length > visible.length ? `/${resources.length}` : ""} resource(s)`
      : skippedServers.length
        ? "No MCP resources are available from connected servers"
        : "No MCP resources exposed",
    content: [
      ...visible.map((resource) => `${resource.server}: ${resource.name ?? resource.uri}\n  ${resource.uri}${resource.mimeType ? `\n  ${resource.mimeType}` : ""}`),
      ...skippedServers.map((item) => `${item.id}: ${mcpServerRecoveryText(item)}`)
    ].join("\n\n"),
    recoverable: skippedServers.length > 0 || undefined,
    recoverySuggestion: skippedServers.length ? "Run mcp.auth to inspect server status, enable MCP, or fix the server command/auth before retrying." : undefined,
    data: {
      resources: visible,
      total: resources.length,
      truncated: resources.length > visible.length,
      servers: selected.map(compactMcpServer)
    }
  };
}

async function readMcpResource(action: Extract<ToolAction, { type: "mcp.read" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.externalContext) {
    return externalContextUnavailable(action.type);
  }
  const server = resolveMcpServer(action.server, context.externalContext.listMcpServers());
  if (server.status === "failed") {
    return server;
  }
  const selected = server.data.servers[0];
  if (selected.status !== "connected") {
    return mcpServerNotReady(action.type, selected);
  }
  return context.externalContext.readMcpResource({
    serverId: selected.id,
    uri: action.uri,
    sessionId: context.sessionId,
    taskId: context.taskId,
    maxBytes: action.maxBytes
  });
}

async function callMcpTool(action: Extract<ToolAction, { type: "mcp.call" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.externalContext) {
    return externalContextUnavailable(action.type);
  }
  return context.externalContext.callMcpTool({
    serverId: action.server,
    tool: action.tool,
    capabilityId: action.capabilityId,
    args: action.args ?? {},
    sessionId: context.sessionId,
    taskId: context.taskId,
    maxBytes: action.maxBytes
  });
}

function mcpAuth(action: Extract<ToolAction, { type: "mcp.auth" }>, context: LocalToolContext): ToolResult {
  if (!context.externalContext) {
    return externalContextUnavailable(action.type);
  }
  const servers = context.externalContext.listMcpServers();
  const resolved = resolveMcpServer(action.server, servers);
  if (resolved.status === "failed") {
    return resolved;
  }
  const rows: Array<CompactMcpServer & { recovery: string }> = resolved.data.servers.map((server) => ({
    ...compactMcpServer(server),
    recovery: mcpServerRecoveryText(server)
  }));
  return {
    action: action.type,
    status: rows.some((row) => row.status !== "connected") ? "partial" : "success",
    summary: rows.length
      ? `mcp.auth inspected ${rows.length} server(s)`
      : "No MCP servers configured",
    content: rows.length
      ? rows.map((row) => `${row.id}: ${row.status}\n  ${row.recovery}`).join("\n\n")
      : "No MCP servers are configured. Add servers under settings.extensions.mcp.servers or pass runtime MCP config.",
    recoverable: true,
    recoverySuggestion: "Use settings.extensions.mcp.enabled and configured servers, then refresh or retry the MCP tool.",
    data: { servers: rows, secret_safe: true }
  };
}

async function invokeSkill(action: Extract<ToolAction, { type: "skill.invoke" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.externalContext) {
    return externalContextUnavailable(action.type);
  }
  return context.externalContext.invokeSkill({
    name: action.name,
    reason: action.reason,
    sessionId: context.sessionId,
    taskId: context.taskId
  });
}

function externalContextUnavailable(action: string): ToolResult {
  return {
    action,
    status: "failed",
    summary: `${action} is available only inside the Swarm runtime`,
    errors: ["Missing runtime externalContext adapter."],
    errorCode: "RUNTIME_CONTEXT_UNAVAILABLE",
    recoverable: true,
    retryable: false,
    recoverySuggestion: "Run this tool from a Swarm session so it can use configured MCP and Skill runtime state."
  };
}

function resolveMcpServer(
  selector: string | undefined,
  servers: ReturnType<NonNullable<LocalToolContext["externalContext"]>["listMcpServers"]>
): { status: "success"; data: { servers: typeof servers } } | ToolResult & { status: "failed"; data: { servers: typeof servers } } {
  if (!selector?.trim()) {
    return { status: "success", data: { servers } };
  }
  const query = selector.trim().toLowerCase();
  const matches = servers.filter((server) => server.id.toLowerCase() === query || server.id.toLowerCase().includes(query));
  if (matches.length === 1) {
    return { status: "success", data: { servers: matches } };
  }
  return {
    action: "mcp.resources",
    status: "failed",
    summary: matches.length > 1 ? `MCP server selector is ambiguous: ${selector}` : `Unknown MCP server: ${selector}`,
    errors: [matches.length > 1 ? `Matches: ${matches.map((item) => item.id).join(", ")}` : `Available servers: ${servers.map((item) => item.id).join(", ") || "none"}`],
    errorCode: matches.length > 1 ? "MCP_SERVER_AMBIGUOUS" : "MCP_SERVER_NOT_FOUND",
    recoverable: true,
    retryable: false,
    recoverySuggestion: "Call mcp.auth or mcp.resources without a server to list configured server ids, then retry with an exact id.",
    data: { servers }
  };
}

function mcpServerNotReady(action: string, server: LocalMcpServer): ToolResult {
  return {
    action,
    status: "failed",
    summary: `MCP server is not connected: ${server.id}`,
    errors: [server.lastError ?? `Server status: ${server.status}`],
    errorCode: "MCP_SERVER_NOT_CONNECTED",
    recoverable: true,
    retryable: true,
    recoverySuggestion: mcpServerRecoveryText(server),
    data: { server: compactMcpServer(server) }
  };
}

function mcpServerRecoveryText(server: LocalMcpServer): string {
  if (server.status === "connected") {
    return "Connected.";
  }
  if (server.status === "disabled") {
    return "Enable MCP and this server in settings, then refresh capabilities.";
  }
  if (server.lastError) {
    return `Fix server configuration or authentication, then refresh. Last error: ${server.lastError}`;
  }
  return "Refresh the server or check its command/auth configuration.";
}

function compactMcpServer(server: LocalMcpServer): CompactMcpServer {
  return {
    id: server.id,
    status: server.status,
    transport: server.transport,
    trust: server.trust,
    exposeResources: server.exposeResources,
    exposeTools: server.exposeTools,
    toolCount: server.toolCount,
    resourceCount: server.resourceCount,
    lastError: server.lastError
  };
}

function compactMcpResource(resource: unknown): CompactMcpResource {
  if (!isRecord(resource)) {
    return { uri: "", value: String(resource) };
  }
  const uri = typeof resource.uri === "string" ? resource.uri : "";
  return {
    uri,
    name: typeof resource.name === "string" ? resource.name : uri,
    title: typeof resource.title === "string" ? resource.title : undefined,
    description: typeof resource.description === "string" ? resource.description : undefined,
    mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
    size: typeof resource.size === "number" ? resource.size : undefined
  };
}

async function executeCodeTest(action: Extract<ToolAction, { type: "code.test" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("code.test requires command");
  }
  const hostValidationError = validateShellCommandForHost(action.command);
  if (hostValidationError) {
    return {
      action: action.type,
      status: "failed",
      summary: hostValidationError,
      content: [`$ ${action.command}`, `ERROR: ${hostValidationError}`].join("\n"),
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: process.platform === "win32"
        ? "Rewrite the test command using PowerShell syntax, or explicitly invoke an available shell such as bash/wsl/cmd when that is intentional."
        : "Rewrite the test command for the configured host shell."
    };
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(5000, action.timeoutMs ?? 300_000);
  const result = await runShellCommand(action.command, { cwd, timeoutMs, maxOutputBytes: 500_000 });

  if (result.error) {
    return {
      action: "code.test",
      status: "failed",
      summary: `test command failed: ${result.error}`,
      content: `$ ${action.command}\nERROR: ${result.error}`,
      errors: [result.error],
      errorCode: classifyProcessError(result),
      retryable: isRetryableProcessError(result),
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, classifyProcessError(result), result.error, result),
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  const passed = result.exitCode === 0;
  return {
    action: "code.test",
    status: passed && !result.timedOut ? "success" : "failed",
    summary: passed ? "tests passed" : `tests failed (exit ${result.exitCode})`,
    content: [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n").trim(),
    errorCode: passed && !result.timedOut ? undefined : classifyProcessError(result),
    retryable: passed && !result.timedOut ? undefined : isRetryableProcessError(result),
    recoverable: passed && !result.timedOut ? undefined : true,
    recoverySuggestion: passed && !result.timedOut ? undefined : recoverySuggestionForToolFailure(action.type, classifyProcessError(result), `${result.stdout}\n${result.stderr}`, result),
    data: {
      cwd: displayPath(cwd, context.workspace),
      passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated
    }
  };
}

async function executeCodeBuild(action: Extract<ToolAction, { type: "code.build" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("code.build requires command");
  }
  const hostValidationError = validateShellCommandForHost(action.command);
  if (hostValidationError) {
    return {
      action: action.type,
      status: "failed",
      summary: hostValidationError,
      content: [`$ ${action.command}`, `ERROR: ${hostValidationError}`].join("\n"),
      errorCode: "INVALID_INPUT",
      retryable: false,
      recoverable: true,
      recoverySuggestion: process.platform === "win32"
        ? "Rewrite the build command using PowerShell syntax, or explicitly invoke an available shell such as bash/wsl/cmd when that is intentional."
        : "Rewrite the build command for the configured host shell."
    };
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(5000, action.timeoutMs ?? 300_000);
  const maxOutputBytes = Math.max(1024, action.maxOutputBytes ?? 500_000);
  const result = await runShellCommand(action.command, { cwd, timeoutMs, maxOutputBytes });
  const content = [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n").trim();
  if (result.error) {
    return {
      action: action.type,
      status: "failed",
      summary: `build command failed: ${result.error}`,
      content: `$ ${action.command}\nERROR: ${result.error}`,
      errors: [result.error],
      errorCode: classifyProcessError(result),
      retryable: isRetryableProcessError(result),
      recoverable: true,
      recoverySuggestion: recoverySuggestionForToolFailure(action.type, classifyProcessError(result), result.error, result),
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }
  return {
    action: action.type,
    status: result.exitCode === 0 && !result.timedOut ? "success" : "failed",
    summary: result.exitCode === 0 ? "build succeeded" : `build failed (exit ${result.exitCode})`,
    content,
    errorCode: result.exitCode === 0 && !result.timedOut ? undefined : classifyProcessError(result),
    retryable: result.exitCode === 0 && !result.timedOut ? undefined : isRetryableProcessError(result),
    recoverable: result.exitCode === 0 && !result.timedOut ? undefined : true,
    recoverySuggestion: result.exitCode === 0 && !result.timedOut ? undefined : recoverySuggestionForToolFailure(action.type, classifyProcessError(result), content, result),
    data: {
      cwd: displayPath(cwd, context.workspace),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated
    }
  };
}

async function executeCodeLint(action: Extract<ToolAction, { type: "code.lint" }>, context: LocalToolContext): Promise<ToolResult> {
  const root = resolveShellCwd(action.root ?? ".", context);

  const statResult = await stat(root).catch(() => null);
  if (!statResult?.isDirectory()) {
    throw new Error(`code.lint root is not a directory: ${displayPath(root, context.workspace)}`);
  }

  const commands: string[] = [];

  const pkgJsonExists = await stat(resolve(root, "package.json")).then(() => true).catch(() => false);
  if (pkgJsonExists) {
    const raw = await readFile(resolve(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; eslintConfig?: unknown };
    if (pkg.scripts?.lint) {
      commands.push(`npm run lint`);
    } else if (pkg.eslintConfig || await hasEslintConfig(root)) {
      commands.push(`npx eslint .`);
    }
  }

  const cargoExists = await stat(resolve(root, "Cargo.toml")).then(() => true).catch(() => false);
  if (cargoExists) {
    commands.push(`cargo clippy -- -D warnings 2>&1 || true`);
  }

  if (commands.length === 0) {
    return {
      action: "code.lint",
      status: "success",
      summary: "no recognized linter configuration found",
      data: { cwd: displayPath(root, context.workspace) }
    };
  }

  const results: ToolResult[] = [];
  for (const cmd of commands) {
    const shellResult = await runShellCommand(cmd, { cwd: root, timeoutMs: 120_000, maxOutputBytes: 300_000 });
    const status = shellResult.exitCode === 0 && !shellResult.timedOut && !shellResult.error ? "success" : "failed";
    const content = [`$ ${cmd}`, shellResult.stdout, shellResult.stderr ? `stderr:\n${shellResult.stderr}` : ""].filter(Boolean).join("\n").trim();
    const errorCode = status === "failed" ? classifyProcessError(shellResult) : undefined;
    results.push({
      action: "code.lint",
      status,
      summary: `lint command exited ${shellResult.exitCode}`,
      content,
      errors: status === "failed" ? [shellResult.error ?? `lint command exited ${shellResult.exitCode ?? shellResult.signal ?? "unknown"}`] : undefined,
      errorCode,
      retryable: status === "failed" ? isRetryableProcessError(shellResult) : undefined,
      recoverable: status === "failed" ? true : undefined,
      recoverySuggestion: status === "failed" ? recoverySuggestionForToolFailure("code.lint", errorCode, content, shellResult) : undefined,
      data: {
        command: cmd,
        exitCode: shellResult.exitCode,
        timedOut: shellResult.timedOut,
        truncated: shellResult.truncated
      }
    });
  }

  return aggregateLintResults(results);
}

async function hasEslintConfig(root: string): Promise<boolean> {
  const candidates = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml"
  ];
  for (const candidate of candidates) {
    if (await stat(resolve(root, candidate)).then(() => true).catch(() => false)) {
      return true;
    }
  }
  return false;
}

export function aggregateLintResults(results: ToolResult[]): ToolResult {
  return {
    action: "code.lint",
    status: results.some((result) => result.status === "failed") ? "failed" : "success",
    summary: `ran ${results.length} linter(s)`,
    content: results.map((r) => r.content).filter(Boolean).join("\n\n"),
    errors: results.flatMap((result) => result.errors ?? []),
    errorCode: results.find((result) => result.status === "failed")?.errorCode,
    retryable: results.some((result) => result.retryable),
    recoverable: results.some((result) => result.status === "failed") ? true : undefined,
    recoverySuggestion: results.find((result) => result.status === "failed")?.recoverySuggestion,
    data: results.map((r) => r.data)
  };
}

async function executeGitStatus(action: Extract<ToolAction, { type: "git.status" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);
  const result = await runShellCommand("git status --porcelain --branch", { cwd, timeoutMs: 30_000, maxOutputBytes: 200_000 });

  if (result.error) {
    return {
      action: "git.status",
      status: "failed",
      summary: `git status failed: ${result.error}`,
      content: `$ git status --porcelain --branch\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }
  if (isNotGitRepositoryResult(result)) {
    return {
      action: "git.status",
      status: "success",
      summary: "git status skipped: not a git repository",
      content: [`$ git status --porcelain --branch`, result.stderr || result.stdout || "not a git repository"].join("\n"),
      data: {
        cwd: displayPath(cwd, context.workspace),
        skipped: true,
        reason: "not_git_repository",
        staged: 0,
        unstaged: 0,
        files: []
      }
    };
  }

  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const staged = lines.filter((l) => !l.startsWith("##") && l[1] !== " " && l[2] !== " ").length;
  const unstaged = lines.filter((l) => l[1] === " " || l[2] === " ").length;
  const branchLine = lines.find((l) => l.startsWith("##"));

  return {
    action: "git.status",
    status: result.exitCode === 0 ? "success" : "failed",
    summary: `git status: ${branchLine ?? "unknown branch"}, ${staged} staged, ${unstaged} unstaged`,
    content: result.stdout,
    data: {
      cwd: displayPath(cwd, context.workspace),
      branch: branchLine?.replace("## ", "").split("...")[0] ?? "unknown",
      staged,
      unstaged,
      files: lines.filter((l) => !l.startsWith("##"))
    }
  };
}

async function executeGitDiff(action: Extract<ToolAction, { type: "git.diff" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);
  const args = action.staged ? ["diff", "--staged"] : ["diff"];
  const cmd = `git ${args.join(" ")}`;
  const result = await runShellCommand(cmd, { cwd, timeoutMs: 60_000, maxOutputBytes: 300_000 });

  if (result.error) {
    return {
      action: "git.diff",
      status: "failed",
      summary: `git diff failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }
  if (isNotGitRepositoryResult(result)) {
    return {
      action: "git.diff",
      status: "success",
      summary: "git diff skipped: not a git repository",
      content: [`$ ${cmd}`, result.stderr || result.stdout || "not a git repository"].join("\n"),
      data: {
        cwd: displayPath(cwd, context.workspace),
        skipped: true,
        reason: "not_git_repository",
        staged: action.staged ?? false,
        bytes: 0,
        truncated: result.truncated
      }
    };
  }

  return {
    action: "git.diff",
    status: result.exitCode === 0 ? "success" : "failed",
    summary: `git ${action.staged ? "diff --staged" : "diff"}: ${result.stdout.length} bytes`,
    content: result.stdout || "(no changes)",
    data: {
      cwd: displayPath(cwd, context.workspace),
      staged: action.staged ?? false,
      bytes: result.stdout.length,
      truncated: result.truncated
    }
  };
}

function isNotGitRepositoryResult(result: ShellCommandResult): boolean {
  return result.exitCode !== 0 && /not a git repository|not a git command|fatal:.*not.*git/i.test(`${result.stderr}\n${result.stdout}`);
}

async function executeGitLog(action: Extract<ToolAction, { type: "git.log" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);
  const maxCommits = Math.max(1, action.maxCommits ?? 20);
  const cmd = `git log --oneline --max-count=${maxCommits}`;
  const result = await runShellCommand(cmd, { cwd, timeoutMs: 30_000, maxOutputBytes: 100_000 });

  if (result.error) {
    return {
      action: "git.log",
      status: "failed",
      summary: `git log failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  const commits = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    action: "git.log",
    status: result.exitCode === 0 ? "success" : "failed",
    summary: `git log: ${commits.length} commits`,
    content: result.stdout || "(no commits)",
    data: {
      cwd: displayPath(cwd, context.workspace),
      count: commits.length,
      commits: commits.map((line) => {
        const space = line.indexOf(" ");
        return { hash: line.slice(0, space), message: line.slice(space + 1) };
      })
    }
  };
}

async function executeGitBranch(action: Extract<ToolAction, { type: "git.branch" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);

  const cmdError = (cmd: string, error: string): ToolResult => ({
    action: "git.branch",
    status: "failed",
    summary: `git branch failed: ${error}`,
    content: `$ ${cmd}\nERROR: ${error}`,
    errors: [error],
    metadata: { cwd: displayPath(cwd, context.workspace), error }
  });

  if (action.action === "list" || !action.action) {
    const cmd = "git branch --list";
    const result = await runShellCommand(cmd, { cwd, timeoutMs: 30_000, maxOutputBytes: 100_000 });
    if (result.error) return cmdError(cmd, result.error);
    const branches = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return {
      action: "git.branch",
      status: result.exitCode === 0 ? "success" : "failed",
      summary: `git branch: ${branches.length} branches`,
      content: result.stdout,
      data: {
        cwd: displayPath(cwd, context.workspace),
        branches: branches.map((b) => ({ name: b.replace(/^\*\s*/, ""), current: b.startsWith("*") }))
      }
    };
  }

  if (action.action === "create" && action.name) {
    const cmd = `git branch "${action.name}"`;
    const result = await runShellCommand(cmd, { cwd, timeoutMs: 30_000, maxOutputBytes: 10_000 });
    if (result.error) return cmdError(cmd, result.error);
    return {
      action: "git.branch",
      status: result.exitCode === 0 ? "success" : "failed",
      summary: `created branch "${action.name}"`,
      content: result.stdout,
      data: { cwd: displayPath(cwd, context.workspace), created: action.name }
    };
  }

  if (action.action === "switch" && action.name) {
    const cmd = `git checkout "${action.name}"`;
    const result = await runShellCommand(cmd, { cwd, timeoutMs: 60_000, maxOutputBytes: 50_000 });
    if (result.error) return cmdError(cmd, result.error);
    return {
      action: "git.branch",
      status: result.exitCode === 0 ? "success" : "failed",
      summary: `switched to branch "${action.name}"`,
      content: result.stdout,
      data: { cwd: displayPath(cwd, context.workspace), switchedTo: action.name }
    };
  }

  throw new Error(`git.branch ${action.action} requires name`);
}

async function executeGitShow(action: Extract<ToolAction, { type: "git.show" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);
  const revision = shellQuote(action.revision?.trim() || "HEAD");
  const cmd = action.path
    ? `git show --no-ext-diff -- ${shellQuote(action.path)}`
    : `git show --no-ext-diff --stat --patch ${revision}`;
  const result = await runShellCommand(cmd, { cwd, timeoutMs: 60_000, maxOutputBytes: Math.max(1024, action.maxOutputBytes ?? 300_000) });
  if (result.error) {
    return {
      action: action.type,
      status: "failed",
      summary: `git show failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }
  return {
    action: action.type,
    status: result.exitCode === 0 ? "success" : "failed",
    summary: `git show: ${result.stdout.length} bytes`,
    content: result.stdout || "(no output)",
    data: {
      cwd: displayPath(cwd, context.workspace),
      revision: action.revision ?? "HEAD",
      path: action.path,
      bytes: result.stdout.length,
      truncated: result.truncated
    }
  };
}

async function executePackageInstall(action: Extract<ToolAction, { type: "package.install" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("package.install requires command");
  }
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(30_000, action.timeoutMs ?? 300_000);
  const result = await runShellCommand(action.command, { cwd, timeoutMs, maxOutputBytes: 300_000 });

  if (result.error) {
    return {
      action: "package.install",
      status: "failed",
      summary: `install failed: ${result.error}`,
      content: `$ ${action.command}\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  return {
    action: "package.install",
    status: result.exitCode === 0 && !result.timedOut ? "success" : "failed",
    summary: result.exitCode === 0 ? "install succeeded" : `install failed (exit ${result.exitCode})`,
    content: [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n").trim(),
    data: {
      cwd: displayPath(cwd, context.workspace),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated
    }
  };
}

async function readPackageInfo(action: Extract<ToolAction, { type: "package.info" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveReadablePath(action.cwd ?? ".", context);
  const manifests = action.manifest ? [action.manifest] : ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  const found: Array<{ path: string; content: string }> = [];
  for (const manifest of manifests) {
    const resolved = resolve(cwd, manifest);
    try {
      assertReadableByDenyRules(resolved, context);
      const info = await stat(resolved);
      if (info.isFile()) {
        found.push({ path: displayPath(resolved, context.workspace), content: await readFile(resolved, "utf8") });
      }
    } catch {
      // Absence is expected when probing multiple manifest names.
    }
  }
  return {
    action: action.type,
    status: "success",
    summary: `found ${found.length} package manifest(s)`,
    content: found.map((item) => `--- ${item.path} ---\n${item.content}`).join("\n\n"),
    data: found.map((item) => ({ path: item.path, bytes: Buffer.byteLength(item.content, "utf8") }))
  };
}

async function detectProject(action: Extract<ToolAction, { type: "project.detect" }>, context: LocalToolContext): Promise<ToolResult> {
  const root = resolveReadablePath(action.root ?? ".", context);
  const index = await ensureWorkspaceIndex(root).catch(() => undefined);
  const manifestNames = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle"
  ];
  const matches = index
    ? index.files
        .filter((item) => manifestNames.some((name) => item.path.endsWith(name)))
        .map((item) => {
          const kind = item.path.endsWith("package.json")
            ? "node"
            : item.path.endsWith("tsconfig.json")
              ? "typescript"
              : item.path.endsWith("pyproject.toml")
                ? "python"
                : item.path.endsWith("Cargo.toml")
                  ? "rust"
                  : item.path.endsWith("go.mod")
                    ? "go"
                    : item.path.endsWith("pom.xml")
                      ? "java-maven"
                      : "java-gradle";
          return { file: displayPath(resolve(root, item.path), context.workspace), kind };
        })
    : [];
  return {
    action: action.type,
    status: "success",
    summary: matches.length ? `detected ${matches.map((item) => item.kind).join(", ")}${index ? " via workspace index" : ""}` : "no known project manifests detected",
    data: {
      root: displayPath(root, context.workspace),
      index_hit: Boolean(index),
      kinds: [...new Set(matches.map((item) => item.kind))],
      manifests: matches,
      workspace_index: index
        ? {
            detected: index.detected,
            packageManager: index.packageManager,
            files: index.files.length,
            recentFiles: index.recentFiles.slice(0, 10).map((file) => displayPath(file.path, context.workspace))
          }
        : undefined
    }
  };
}

type CommandRunnerOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  outputPersistence?: {
    sessionId?: string;
    taskId?: string;
    action: string;
    command: string;
  };
};

function commandOutputPersistence(
  action: Extract<ToolAction, { type: "shell.exec" | "powershell.exec" }>,
  context: LocalToolContext
): CommandRunnerOptions["outputPersistence"] {
  return {
    sessionId: context.sessionId,
    taskId: context.taskId ?? `${action.type}.command`,
    action: action.type,
    command: action.command
  };
}

/** Shared shell runner used by tools that wrap shell commands. */
async function runShellCommand(
  command: string,
  options: CommandRunnerOptions
): Promise<ShellCommandResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let stdoutFull = "";
    let stderrFull = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (extra: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      void finalizeCommandResult({
        stdout,
        stderr,
        stdoutFull,
        stderrFull,
        timedOut,
        truncated,
        extra,
        options
      }).then(resolvePromise);
    };

    const child = spawn(shell, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") {
        stdoutFull += text;
      } else {
        stderrFull += text;
      }
      const next = stream === "stdout" ? stdoutFull : stderrFull;
      const nextBytes = Buffer.byteLength(next, "utf8");
      if (nextBytes > options.maxOutputBytes) {
        truncated = true;
        const sliced = Buffer.from(next, "utf8").subarray(0, options.maxOutputBytes).toString("utf8");
        if (stream === "stdout") stdout = sliced;
        else stderr = sliced;
      } else if (stream === "stdout") {
        stdout = next;
      } else {
        stderr = next;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({ exitCode: code, signal });
    });
  });
}

async function runPowerShellCommand(
  command: string,
  options: CommandRunnerOptions
): Promise<ShellCommandResult> {
  const candidates = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];
  let lastMissing = "PowerShell executable not found";
  for (const shell of candidates) {
    const result = await runDirectCommand(shell, ["-NoProfile", "-Command", command], options);
    if (result) {
      return result;
    }
    lastMissing = `${shell} not found`;
  }
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    error: lastMissing
  };
}

async function runDirectCommand(
  command: string,
  args: string[],
  options: CommandRunnerOptions
): Promise<ShellCommandResult | undefined> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let stdoutFull = "";
    let stderrFull = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (extra: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      void finalizeCommandResult({
        stdout,
        stderr,
        stdoutFull,
        stderrFull,
        timedOut,
        truncated,
        extra,
        options
      }).then(resolvePromise);
    };

    const child = spawn(command, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") {
        stdoutFull += text;
      } else {
        stderrFull += text;
      }
      const next = stream === "stdout" ? stdoutFull : stderrFull;
      const nextBytes = Buffer.byteLength(next, "utf8");
      if (nextBytes > options.maxOutputBytes) {
        truncated = true;
        const sliced = Buffer.from(next, "utf8").subarray(0, options.maxOutputBytes).toString("utf8");
        if (stream === "stdout") stdout = sliced;
        else stderr = sliced;
      } else if (stream === "stdout") {
        stdout = next;
      } else {
        stderr = next;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({ exitCode: code, signal });
    });
  });
}

async function finalizeCommandResult(input: {
  stdout: string;
  stderr: string;
  stdoutFull: string;
  stderrFull: string;
  timedOut: boolean;
  truncated: boolean;
  extra: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string };
  options: CommandRunnerOptions;
}): Promise<ShellCommandResult> {
  const fullContent = commandOutputContent(input.options.outputPersistence?.command, input.stdoutFull, input.stderrFull);
  const preview = commandOutputContent(input.options.outputPersistence?.command, input.stdout, input.stderr);
  const persisted = input.truncated && input.options.outputPersistence
    ? await persistCommandOutput(input.options.outputPersistence, fullContent)
    : undefined;
  return {
    exitCode: input.extra.exitCode ?? null,
    signal: input.extra.signal ?? null,
    stdout: input.stdout,
    stderr: input.stderr,
    timedOut: input.timedOut,
    truncated: input.truncated,
    error: input.extra.error,
    persistedOutputPath: persisted?.path,
    persistedOutputSize: persisted?.bytes,
    preview: input.truncated ? preview : undefined,
    hasMore: input.truncated || undefined
  };
}

async function persistCommandOutput(
  persistence: NonNullable<CommandRunnerOptions["outputPersistence"]>,
  content: string
): Promise<{ path: string; bytes: number } | undefined> {
  try {
    const ref = await writeTaskOutput({
      sessionId: persistence.sessionId ?? "global",
      taskId: persistence.taskId ?? `${persistence.action}.command`,
      attempt: 0,
      content
    });
    return { path: ref.path, bytes: ref.bytes };
  } catch {
    return undefined;
  }
}

function commandOutputContent(command: string | undefined, stdout: string, stderr: string): string {
  return [
    command ? `$ ${command}` : undefined,
    stdout,
    stderr ? `stderr:\n${stderr}` : undefined
  ].filter(Boolean).join("\n").trim();
}

function validateShellCommandForHost(command: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  if (explicitlyInvokesAlternateShell(command)) {
    return undefined;
  }
  if (usesPowerShellIncompatiblePosix(command)) {
    return "Command uses POSIX-only shell syntax but local commands run in PowerShell on Windows.";
  }
  return undefined;
}

function usesPowerShellIncompatiblePosix(command: string): boolean {
  const trimmed = command.trim();
  return [
    /\bmkdir\s+-p\b/i,
    /<<\s*['"]?EOF['"]?/i,
    /\bcat\s+>\s+\S+\s+<</i,
    /\bcd\s+\$\(pwd\)/i,
    /\s&&\s/,
    /(^|\s)&\s*sleep\b/i
  ].some((pattern) => pattern.test(trimmed));
}

function explicitlyInvokesAlternateShell(command: string): boolean {
  return /^(?:cmd(?:\.exe)?|bash|sh|wsl|pwsh|powershell(?:\.exe)?)\b/i.test(command.trim());
}

async function collectFiles(
  root: string,
  context: LocalToolContext,
  options: {
    maxFiles: number;
    maxDepth: number;
    filter?: (file: WalkedFile) => boolean;
  }
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const ignored = new Set(["node_modules", "dist", ".git", ".swarm"]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= options.maxFiles || depth > options.maxDepth) {
      return;
    }
    assertReadableByDenyRules(dir, context);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= options.maxFiles || ignored.has(entry.name)) {
        continue;
      }
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && !isPathDenied(fullPath, context)) {
        const file = { path: fullPath, display: displayPath(fullPath, context.workspace) };
        if (!options.filter || options.filter(file)) {
          files.push(file);
        }
      }
    }
  }

  const rootInfo = await stat(root);
  if (rootInfo.isFile()) {
    const file = { path: root, display: displayPath(root, context.workspace) };
    return !options.filter || options.filter(file) ? [file] : [];
  }
  await walk(root, 0);
  return files;
}

function classifyFsError(error: NodeJS.ErrnoException | Error): string {
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "FS_NOT_FOUND";
  if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  if (code === "ENOTDIR" || code === "EISDIR") return "INVALID_INPUT";
  return code ? `FS_${code}` : "TOOL_FAILED";
}

function isPathDenied(path: string, context: LocalToolContext): boolean {
  try {
    assertReadableByDenyRules(path, context);
    return false;
  } catch {
    return true;
  }
}

async function readTextIfPossible(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (text.includes("\u0000")) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function grepMaxMatches(action: Extract<ToolAction, { type: "file.grep" }>): number {
  const explicit = action.maxMatches;
  if (explicit === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, explicit ?? 1000);
}

function pageGrepItems(
  matches: GrepMatch[],
  action: Extract<ToolAction, { type: "file.grep" }>
): { items: GrepMatch[]; appliedLimit?: number; appliedOffset?: number; totalBeforePaging: number } {
  const offset = Math.max(0, action.offset ?? 0);
  const limit = action.headLimit ?? action.maxMatches ?? 100;
  const afterOffset = matches.slice(offset);
  if (limit === 0) {
    return {
      items: afterOffset,
      appliedOffset: offset || undefined,
      totalBeforePaging: matches.length
    };
  }
  const effectiveLimit = Math.max(1, limit);
  return {
    items: afterOffset.slice(0, effectiveLimit),
    appliedLimit: afterOffset.length > effectiveLimit ? effectiveLimit : undefined,
    appliedOffset: offset || undefined,
    totalBeforePaging: matches.length
  };
}

function uniqueGrepPaths(matches: GrepMatch[]): string[] {
  return [...new Set(matches.map((match) => match.path))];
}

function countGrepMatchesByPath(matches: GrepMatch[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}

function renderGrepMatches(matches: GrepMatch[]): string {
  return matches.flatMap((match) => {
    const lines: string[] = [];
    for (const before of match.before ?? []) {
      lines.push(`${match.path}-${before}`);
    }
    lines.push(`${match.path}:${match.line}:${match.text}`);
    for (const after of match.after ?? []) {
      lines.push(`${match.path}-${after}`);
    }
    return lines;
  }).join("\n");
}

function grepMultilineFile(input: {
  file: WalkedFile;
  text: string;
  regex: RegExp;
  limit: number;
  beforeContext: number;
  afterContext: number;
}): GrepMatch[] {
  if (input.limit <= 0) {
    return [];
  }
  const lines = input.text.split(/\r?\n/);
  const lineStarts = lineStartOffsets(lines);
  const matches: GrepMatch[] = [];
  const regex = input.regex;
  regex.lastIndex = 0;
  for (let match = regex.exec(input.text); match && matches.length < input.limit; match = regex.exec(input.text)) {
    const start = match.index;
    const matchedText = match[0] || "";
    const lineIndex = lineIndexForOffset(lineStarts, start);
    const endLineIndex = lineIndexForOffset(lineStarts, start + Math.max(0, matchedText.length - 1));
    matches.push({
      path: input.file.display,
      line: lineIndex + 1,
      text: lines.slice(lineIndex, endLineIndex + 1).join("\\n"),
      before: input.beforeContext ? lines.slice(Math.max(0, lineIndex - input.beforeContext), lineIndex) : undefined,
      after: input.afterContext ? lines.slice(endLineIndex + 1, endLineIndex + 1 + input.afterContext) : undefined
    });
    if (matchedText.length === 0) {
      regex.lastIndex += 1;
    }
  }
  return matches;
}

function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = lineStarts[mid];
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < current) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(lineStarts.length - 1, low));
}

function matchesGrepFileFilter(file: WalkedFile, action: Extract<ToolAction, { type: "file.grep" }>): boolean {
  const typeGlob = action.fileType ? globForFileType(action.fileType) : undefined;
  const includeMatches = !action.include || matchesGlob(file.display, action.include) || matchesGlob(basename(file.display), action.include);
  const typeMatches = !typeGlob || matchesGlob(file.display, typeGlob) || matchesGlob(basename(file.display), typeGlob);
  return includeMatches && typeMatches;
}

function globForFileType(type: string): string | undefined {
  const normalized = type.trim().toLowerCase();
  const aliases: Record<string, string> = {
    js: "**/*.js",
    jsx: "**/*.jsx",
    ts: "**/*.ts",
    tsx: "**/*.tsx",
    py: "**/*.py",
    python: "**/*.py",
    rs: "**/*.rs",
    rust: "**/*.rs",
    go: "**/*.go",
    java: "**/*.java",
    json: "**/*.json",
    md: "**/*.md",
    markdown: "**/*.md",
    yaml: "**/*.{yaml,yml}",
    yml: "**/*.yml"
  };
  return aliases[normalized] ?? (normalized ? `**/*.${normalized.replace(/^\./, "")}` : undefined);
}

function normalizeActionName(action: string, inputs: Record<string, unknown> = {}): ToolAction["type"] {
  if (["Read", "read_file", "tool.file.read", "file.read"].includes(action)) {
    return "file.read";
  }
  if (["LS", "list_files", "tool.file.list", "file.list", "ls"].includes(action)) {
    return "file.list";
  }
  if (["Glob", "glob", "tool.file.glob", "file.glob"].includes(action)) {
    return "file.glob";
  }
  if (["Grep", "grep", "tool.file.grep", "file.grep"].includes(action)) {
    return "file.grep";
  }
  if (["stat", "tool.file.stat", "file.stat"].includes(action)) {
    return "file.stat";
  }
  if (["Write", "write_file", "tool.file.write", "file.write"].includes(action)) {
    return "file.write";
  }
  if (["Edit", "edit_file", "tool.file.edit", "file.edit"].includes(action)) {
    return "file.edit";
  }
  if (["Delete", "delete_file", "tool.file.delete", "file.delete"].includes(action)) {
    return "file.delete";
  }
  if (["TodoWrite", "todo", "todo_write", "todo.write", "tool.todo.write"].includes(action)) {
    return "todo.write";
  }
  if (["AskUserQuestion", "ask_user_question", "ask.user_question", "ask.question", "question.ask"].includes(action)) {
    return "ask_user_question";
  }
  if (["EnterPlanMode", "enter_plan_mode", "plan.enter", "plan_enter", "plan.mode.enter"].includes(action)) {
    return "plan.enter";
  }
  if (["ExitPlanMode", "exit_plan_mode", "plan.exit", "plan_exit", "plan.mode.exit"].includes(action)) {
    return "plan.exit";
  }
  if (["EnterWorktree", "enter_worktree", "worktree.enter", "worktree_enter"].includes(action)) {
    return "worktree.enter";
  }
  if (["ExitWorktree", "exit_worktree", "worktree.exit", "worktree_exit"].includes(action)) {
    return "worktree.exit";
  }
  if (["BlackboardWrite", "blackboard_write", "blackboard.write"].includes(action)) {
    return "blackboard.write";
  }
  if (["BlackboardRead", "blackboard_read", "blackboard.read"].includes(action)) {
    return "blackboard.read";
  }
  if (["BlackboardSearch", "blackboard_search", "blackboard.search"].includes(action)) {
    return "blackboard.search";
  }
  if (["BlackboardList", "blackboard_list", "blackboard.list"].includes(action)) {
    return "blackboard.list";
  }
  if (["AgentList", "agent_list", "agent.list", "agents.list"].includes(action)) {
    return "agent.list";
  }
  if (["AgentStatus", "agent_status", "agent.status", "worker.status"].includes(action)) {
    return "agent.status";
  }
  if (["AgentStop", "agent_stop", "agent.stop", "worker.stop"].includes(action)) {
    return "agent.stop";
  }
  if (["AgentContinue", "agent_continue", "agent.continue", "continue_agent", "worker.continue"].includes(action)) {
    return "agent.continue";
  }
  if (["TaskCreate", "task_create", "task.create", "tasks.create"].includes(action)) {
    return "task.create";
  }
  if (["TaskUpdate", "task_update", "task.update", "tasks.update"].includes(action)) {
    return "task.update";
  }
  if (["TaskGet", "task_get", "task.get", "tasks.get"].includes(action)) {
    return "task.get";
  }
  if (["TaskList", "task_list", "task.list", "tasks.list"].includes(action)) {
    return "task.list";
  }
  if (["TaskOutput", "task_output", "task.output", "tasks.output"].includes(action)) {
    return "task.output";
  }
  if (["TaskStop", "task_stop", "task.stop", "tasks.stop"].includes(action)) {
    return "task.stop";
  }
  if (["Bash", "bash", "shell", "Shell", "RunCommand", "run_command", "run.command", "command", "tool.shell.exec", "shell.exec"].includes(action)) {
    return "shell.exec";
  }
  if (["PowerShell", "Powershell", "powershell", "Pwsh", "pwsh", "powershell_exec", "tool.powershell.exec", "powershell.exec"].includes(action)) {
    return "powershell.exec";
  }
  if (["ProcessStart", "process_start", "process.start", "background.start"].includes(action)) {
    return "process.start";
  }
  if (["ProcessStatus", "process_status", "process.status", "background.status"].includes(action)) {
    return "process.status";
  }
  if (["ProcessList", "process_list", "process.list", "background.list"].includes(action)) {
    return "process.list";
  }
  if (["ProcessTail", "process_tail", "process.tail", "background.tail"].includes(action)) {
    return "process.tail";
  }
  if (["ProcessGrep", "process_grep", "process.grep", "background.grep"].includes(action)) {
    return "process.grep";
  }
  if (["ProcessStop", "process_stop", "process.stop", "KillShell", "background.stop"].includes(action)) {
    return "process.stop";
  }
  if (["WebSearch", "web_search", "web.search"].includes(action)) {
    return "web.search";
  }
  if (["WebFetch", "web_fetch", "web.fetch", "fetch"].includes(action)) {
    return "web.fetch";
  }
  if (["Config", "config", "config.get", "config_get"].includes(action)) {
    return inputs.value === undefined ? "config.get" : "config.set";
  }
  if (["ConfigSet", "config.set", "config_set"].includes(action)) {
    return "config.set";
  }
  if (["McpResources", "ListMcpResources", "list_mcp_resources", "mcp.resources", "mcp_resources"].includes(action)) {
    return "mcp.resources";
  }
  if (["McpRead", "ReadMcpResource", "read_mcp_resource", "mcp.read", "mcp_read"].includes(action)) {
    return "mcp.read";
  }
  if (["McpAuth", "mcp.auth", "mcp_auth", "mcp.authenticate"].includes(action)) {
    return "mcp.auth";
  }
  if (["McpCall", "MCPTool", "mcp.call", "mcp_call"].includes(action)) {
    return "mcp.call";
  }
  if (["SkillInvoke", "SkillTool", "skill.invoke", "skill_invoke", "skill.activate"].includes(action)) {
    return "skill.invoke";
  }
  if (["AgentMessage", "SendMessageTool", "SendMessage", "send_message", "agent.message", "agent_message", "worker.message"].includes(action)) {
    return "agent.message";
  }
  if (["SleepTool", "RuntimeSleep", "sleep", "runtime.sleep", "runtime_sleep"].includes(action)) {
    return "runtime.sleep";
  }
  if (["SyntheticOutputTool", "StructuredOutput", "structured.output", "structured_output", "synthetic.output"].includes(action)) {
    return "structured.output";
  }
  if (["REPLTool", "ReplMode", "repl.mode", "repl_mode"].includes(action)) {
    return "repl.mode";
  }
  if (["ScheduleCronTool", "ScheduleCreate", "CronCreate", "schedule.create", "schedule_create", "cron.create", "cron_create"].includes(action)) {
    return "schedule.create";
  }
  if (["ScheduleList", "CronList", "schedule.list", "schedule_list", "cron.list", "cron_list"].includes(action)) {
    return "schedule.list";
  }
  if (["ScheduleDelete", "CronDelete", "schedule.delete", "schedule_delete", "cron.delete", "cron_delete"].includes(action)) {
    return "schedule.delete";
  }
  if (["RemoteTriggerTool", "RemoteTrigger", "remote.trigger", "remote_trigger"].includes(action)) {
    return "remote.trigger";
  }
  if (["TeamCreateTool", "TeamCreate", "team.create", "team_create"].includes(action)) {
    return "team.create";
  }
  if (["TeamDeleteTool", "TeamDelete", "team.delete", "team_delete"].includes(action)) {
    return "team.delete";
  }
  if (["NotebookEdit", "notebook_edit", "notebook.edit"].includes(action)) {
    return "notebook.edit";
  }
  if (["code_test", "code.test", "run_tests", "run.test", "test"].includes(action)) {
    return "code.test";
  }
  if (["code_lint", "code.lint", "lint"].includes(action)) {
    return "code.lint";
  }
  if (["git_status", "git.status"].includes(action)) {
    return "git.status";
  }
  if (["git_diff", "git.diff"].includes(action)) {
    return "git.diff";
  }
  if (["git_log", "git.log"].includes(action)) {
    return "git.log";
  }
  if (["git_branch", "git.branch"].includes(action)) {
    return "git.branch";
  }
  if (["package_install", "package.install", "install"].includes(action)) {
    return "package.install";
  }
  if (["lsp_diagnostics", "lsp.diagnostics", "LspDiagnostics"].includes(action)) {
    return "lsp.diagnostics";
  }
  if (["lsp_hover", "lsp.hover", "LspHover"].includes(action)) {
    return "lsp.hover";
  }
  if (["lsp_definition", "lsp.definition", "LspDefinition"].includes(action)) {
    return "lsp.definition";
  }
  if (["lsp_references", "lsp.references", "LspReferences"].includes(action)) {
    return "lsp.references";
  }
  if (["lsp_document_symbols", "lsp.document_symbols", "LspDocumentSymbols"].includes(action)) {
    return "lsp.document_symbols";
  }
  if (["lsp_workspace_symbols", "lsp.workspace_symbols", "LspWorkspaceSymbols"].includes(action)) {
    return "lsp.workspace_symbols";
  }
  if (["lsp_completion", "lsp.completion", "LspCompletion"].includes(action)) {
    return "lsp.completion";
  }
  if (["lsp_code_actions", "lsp.code_actions", "LspCodeActions"].includes(action)) {
    return "lsp.code_actions";
  }
  if (["lsp_rename_preview", "lsp.rename_preview", "LspRenamePreview"].includes(action)) {
    return "lsp.rename_preview";
  }
  if (["lsp_format", "lsp.format", "LspFormat"].includes(action)) {
    return "lsp.format";
  }
  if (["Agent", "Task", "agent_delegate", "agent.delegate", "delegate"].includes(action)) {
    return "agent.delegate";
  }
  return action as ToolAction["type"];
}

function isRunCommandAlias(action: string): boolean {
  return ["RunCommand", "run_command", "run.command", "command"].includes(action);
}

function runCommandAliasTarget(command: unknown): ToolAction["type"] {
  return typeof command === "string" && looksLikeVerificationCommand(command)
    ? "code.test"
    : "shell.exec";
}

function looksLikeVerificationCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn)\s+(run\s+)?test\b/i.test(command)
    || /\bnode(?:\.exe)?\b[\s\S]*(?:\btest\b|\bspec\b|src[\\/]+cli\.js)/i.test(command)
    || /\b(smoke|verify|verification)\b/i.test(command);
}

function isLspActionType(action: ToolAction["type"]): action is Extract<ToolAction, { type: `lsp.${string}` }>["type"] {
  return [
    "lsp.diagnostics",
    "lsp.hover",
    "lsp.definition",
    "lsp.references",
    "lsp.document_symbols",
    "lsp.workspace_symbols",
    "lsp.completion",
    "lsp.code_actions",
    "lsp.rename_preview",
    "lsp.format"
  ].includes(action);
}

function isLspToolAction(action: ToolAction): action is Extract<ToolAction, { type: `lsp.${string}` }> {
  return isLspActionType(action.type);
}

function normalizeLspAction(action: Extract<ToolAction, { type: `lsp.${string}` }>["type"], inputs: Record<string, unknown>): ToolAction {
  const common = {
    provider: optionalStringInput(inputs.provider ?? inputs.lspProvider ?? inputs.lsp_provider),
    root: optionalStringInput(inputs.root ?? inputs.cwd),
    timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms ?? inputs.timeout),
    maxResults: numberInput(inputs.maxResults ?? inputs.max_results ?? inputs.maxItems ?? inputs.max_items ?? inputs.limit)
  };
  const fileInput = () => requiredStringInput(inputs.file ?? inputs.file_path ?? inputs.filePath ?? inputs.path, `${action} requires file`);
  const document = () => ({
    ...common,
    path: fileInput(),
    file: fileInput()
  });
  const lineInput = () => {
    const line = numberInput(inputs.line);
    if (line !== undefined) {
      return line;
    }
    const zeroBased = numberInput(inputs.lineZeroBased ?? inputs.line_zero_based ?? inputs.line0 ?? inputs.lspLine ?? inputs.lsp_line);
    return zeroBased === undefined ? 1 : zeroBased + 1;
  };
  const columnInput = () => {
    const column = numberInput(inputs.column);
    if (column !== undefined) {
      return column;
    }
    const character = numberInput(inputs.character ?? inputs.ch);
    return character === undefined ? 1 : character + 1;
  };
  const position = () => ({
    ...document(),
    line: lineInput(),
    character: Math.max(0, columnInput() - 1),
    column: columnInput()
  });
  if (action === "lsp.diagnostics") {
    return {
      type: action,
      ...document(),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines),
      diagnosticsTimeoutMs: numberInput(inputs.diagnosticsTimeoutMs ?? inputs.diagnostics_timeout_ms)
    };
  }
  if (action === "lsp.hover") {
    return { type: action, ...position() };
  }
  if (action === "lsp.definition") {
    return { type: action, ...position(), contextLines: numberInput(inputs.contextLines ?? inputs.context_lines) };
  }
  if (action === "lsp.references") {
    return {
      type: action,
      ...position(),
      includeDeclaration: inputs.includeDeclaration === false || inputs.include_declaration === false ? false : undefined,
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines)
    };
  }
  if (action === "lsp.document_symbols") {
    return { type: action, ...document() };
  }
  if (action === "lsp.workspace_symbols") {
    return {
      type: action,
      ...common,
      query: requiredStringInput(inputs.query, "lsp.workspace_symbols requires query")
    };
  }
  if (action === "lsp.completion") {
    return {
      type: action,
      ...position(),
      triggerCharacter: optionalStringInput(inputs.triggerCharacter ?? inputs.trigger_character),
      prefix: optionalStringInput(inputs.prefix)
    };
  }
  if (action === "lsp.code_actions") {
    const range = lspRangeInput(inputs);
    return {
      type: action,
      ...document(),
      line: numberInput(inputs.line),
      character: Math.max(0, columnInput() - 1),
      column: columnInput(),
      range,
      startLine: range?.start.line,
      startCharacter: range ? Math.max(0, range.start.column - 1) : undefined,
      endLine: range?.end.line,
      endCharacter: range ? Math.max(0, range.end.column - 1) : undefined
    };
  }
  if (action === "lsp.rename_preview") {
    return {
      type: action,
      ...position(),
      newName: requiredStringInput(inputs.newName ?? inputs.new_name, "lsp.rename_preview requires newName"),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines)
    };
  }
  return {
    type: "lsp.format",
    ...document(),
    tabSize: numberInput(inputs.tabSize ?? inputs.tab_size),
    insertSpaces: booleanInput(inputs.insertSpaces ?? inputs.insert_spaces)
  };
}

function lspRangeInput(inputs: Record<string, unknown>): { start: { line: number; column: number }; end: { line: number; column: number } } | undefined {
  const rawRange = inputs.range;
  if (isRecord(rawRange) && isRecord(rawRange.start) && isRecord(rawRange.end)) {
    return {
      start: {
        line: numberInput(rawRange.start.line) ?? 1,
        column: lspColumnInput(rawRange.start.column, rawRange.start.character)
      },
      end: {
        line: numberInput(rawRange.end.line) ?? 1,
        column: lspColumnInput(rawRange.end.column, rawRange.end.character)
      }
    };
  }
  const startLine = numberInput(inputs.startLine ?? inputs.start_line);
  const endLine = numberInput(inputs.endLine ?? inputs.end_line);
  if (startLine === undefined && endLine === undefined) {
    return undefined;
  }
  return {
    start: {
      line: startLine ?? endLine ?? 1,
      column: lspColumnInput(inputs.startColumn ?? inputs.start_column, inputs.startCharacter ?? inputs.start_character)
    },
    end: {
      line: endLine ?? startLine ?? 1,
      column: lspColumnInput(inputs.endColumn ?? inputs.end_column, inputs.endCharacter ?? inputs.end_character)
    }
  };
}

function lspColumnInput(column: unknown, character: unknown): number {
  const oneBased = numberInput(column);
  if (oneBased !== undefined) {
    return oneBased;
  }
  const zeroBased = numberInput(character);
  return zeroBased === undefined ? 1 : zeroBased + 1;
}

function patchHunksInput(value: unknown): Array<{ oldText: string; newText: string }> {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = isRecord(item) ? item : {};
        return {
          oldText: stringInput(record.oldText ?? record.old_text ?? record.oldString ?? record.old_string),
          newText: stringInput(record.newText ?? record.new_text ?? record.newString ?? record.new_string)
        };
      })
      .filter((hunk) => hunk.oldText);
  }
  if (isRecord(value)) {
    return patchHunksInput([value]);
  }
  return [];
}

function jsonEditOperationInput(value: unknown): "set" | "delete" | "merge" {
  return value === "delete" || value === "merge" ? value : "set";
}

function notebookCellTypeInput(value: unknown): "code" | "markdown" | undefined {
  return value === "code" || value === "markdown" ? value : undefined;
}

function notebookEditModeInput(value: unknown): "replace" | "insert" | "delete" | undefined {
  return value === "insert" || value === "delete" || value === "replace" ? value : undefined;
}

function blackboardEntryTypeInput(value: unknown): import("../protocol/types.js").BlackboardEntry["type"] {
  const normalized = optionalBlackboardEntryTypeInput(value);
  if (!normalized) {
    throw new Error("Blackboard entry type must be one of plan, observation, evidence, result, critique, decision, artifact");
  }
  return normalized;
}

function optionalBlackboardEntryTypeInput(value: unknown): import("../protocol/types.js").BlackboardEntry["type"] | undefined {
  if (
    value === "plan" ||
    value === "observation" ||
    value === "evidence" ||
    value === "result" ||
    value === "critique" ||
    value === "decision" ||
    value === "artifact"
  ) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return undefined;
}

function blackboardVisibilityInput(value: unknown): import("../protocol/types.js").BlackboardEntry["visibility"] | undefined {
  return value === "private" || value === "team" || value === "public" ? value : undefined;
}

function stringInput(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function requiredStringInput(value: unknown, message: string): string {
  const text = stringInput(value).trim();
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function optionalStringInput(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function stringListInput(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function stringArrayInput(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item)).filter((item) => item.trim());
}

function agentInvocationModeInput(value: unknown): "call_subagent" | "handoff" | "parallel" | undefined {
  if (value === "call_subagent" || value === "handoff" || value === "parallel") {
    return value;
  }
  if (value === "background" || value === "async" || value === "async_launched") {
    return "parallel";
  }
  return undefined;
}

function agentWorkerStatusInput(value: unknown): "pending" | "running" | "completed" | "failed" | "stopped" | undefined {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "stopped") {
    return value;
  }
  return undefined;
}

function taskTypeInput(value: unknown): Extract<ToolAction, { type: "task.create" }>["taskType"] {
  if (value === "research" || value === "coding" || value === "analysis" || value === "review" || value === "tool_call" || value === "planning" || value === "aggregation") {
    return value;
  }
  return undefined;
}

function swarmTaskStatusInput(value: unknown): Extract<ToolAction, { type: "task.create" }>["status"] {
  if (value === "created" || value === "pending" || value === "assigned" || value === "running" || value === "blocked" || value === "completed" || value === "failed" || value === "cancelled") {
    return value;
  }
  return undefined;
}

function scheduleStatusInput(value: unknown): Extract<ToolAction, { type: "schedule.list" }>["status"] {
  if (value === "active" || value === "paused" || value === "expired") {
    return value;
  }
  return undefined;
}

function writePolicyInput(value: unknown): Extract<ToolAction, { type: "task.create" }>["write_policy"] {
  if (value === "read_only" || value === "scoped_write" || value === "workspace_write") {
    return value;
  }
  return undefined;
}

function recordInput(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function requiredNumberInput(value: unknown, message: string): number {
  const number = numberInput(value);
  if (number === undefined) {
    throw new Error(message);
  }
  return number;
}

function agentAddressInput(value: unknown): Extract<ToolAction, { type: "task.create" }>["assigned_to"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const agent_id = optionalStringInput(value.agent_id ?? value.agentId);
  const role = optionalStringInput(value.role);
  const capability = optionalStringInput(value.capability);
  return agent_id || role || capability ? { agent_id, role, capability } : undefined;
}

function todoListInput(value: unknown): Array<{ content: string; activeForm?: string; status: "pending" | "in_progress" | "completed" }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : { content: item };
      const rawStatus = String(record.status ?? "pending");
      const status: "pending" | "in_progress" | "completed" =
        rawStatus === "completed" || rawStatus === "in_progress" ? rawStatus : "pending";
      return {
        content: String(record.content ?? record.task ?? record.text ?? "").trim(),
        activeForm: optionalStringInput(record.activeForm ?? record.active_form),
        status
      };
    })
    .filter((todo) => todo.content);
}

function questionChoicesInput(value: unknown): Array<{ label: string; description?: string; preview?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const choices = value
    .map((item) => {
      if (typeof item === "string") {
        return { label: item.trim() };
      }
      const record = isRecord(item) ? item : {};
      return {
        label: stringInput(record.label ?? record.value ?? record.title ?? record.name).trim(),
        description: optionalStringInput(record.description ?? record.detail ?? record.help),
        preview: optionalStringInput(record.preview ?? record.example)
      };
    })
    .filter((choice) => choice.label);
  return choices.length ? choices : undefined;
}

function structuredQuestionsInput(value: unknown): Extract<ToolAction, { type: "ask_user_question" }>["questions"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const questions = value
    .map((item) => {
      if (typeof item === "string") {
        return { question: item.trim(), options: [] };
      }
      const record = isRecord(item) ? item : {};
      return {
        question: stringInput(record.question ?? record.prompt ?? record.text ?? record.title).trim(),
        header: optionalStringInput(record.header ?? record.label),
        options: questionChoicesInput(record.options ?? record.choices) ?? [],
        multiSelect: booleanInput(record.multiSelect ?? record.multi_select)
      };
    })
    .filter((question) => question.question || question.options.length);
  return questions.length ? questions : undefined;
}

function allowedPromptsInput(value: unknown): Extract<ToolAction, { type: "plan.exit" }>["allowedPrompts"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const prompts = value
    .map((item) => {
      const record = isRecord(item) ? item : {};
      return {
        tool: stringInput(record.tool ?? record.action ?? record.name).trim(),
        prompt: stringInput(record.prompt ?? record.text ?? record.description).trim()
      };
    })
    .filter((prompt) => prompt.tool && prompt.prompt);
  return prompts.length ? prompts : undefined;
}

function firstQuestionText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
    if (!isRecord(item)) {
      continue;
    }
    const question = optionalStringInput(item.question ?? item.prompt ?? item.text ?? item.title)?.trim();
    if (question) {
      return question;
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function numberInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function validateStructuredOutputValue(value: unknown, schema: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) {
    return "value is required";
  }
  if (!schema) {
    return undefined;
  }
  const type = schema.type;
  if (typeof type === "string" && !jsonValueMatchesSchemaType(value, type)) {
    return `expected ${type}`;
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  if (required.length && isRecord(value)) {
    const missing = required.find((field) => value[field] === undefined);
    if (missing) {
      return `missing required field ${missing}`;
    }
  } else if (required.length) {
    return "required fields need an object value";
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties && isRecord(value)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] === undefined || !isRecord(propertySchema)) {
        continue;
      }
      const propertyType = propertySchema.type;
      if (typeof propertyType === "string" && !jsonValueMatchesSchemaType(value[key], propertyType)) {
        return `field ${key} expected ${propertyType}`;
      }
    }
  }
  return undefined;
}

function jsonValueMatchesSchemaType(value: unknown, type: string): boolean {
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "string") {
    return typeof value === "string";
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (type === "null") {
    return value === null;
  }
  return true;
}

function booleanInput(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === true || value === false) {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function processStatusInput(value: unknown): Extract<ToolAction, { type: "process.list" }>["status"] {
  if (value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "unknown") {
    return value;
  }
  return undefined;
}

function grepOutputModeInput(value: unknown): Extract<ToolAction, { type: "file.grep" }>["outputMode"] {
  if (value === "content" || value === "files_with_matches" || value === "count") {
    return value;
  }
  return undefined;
}

function worktreeExitModeInput(value: unknown): Extract<ToolAction, { type: "worktree.exit" }>["mode"] {
  return value === "remove" ? "remove" : "keep";
}

function compileSearchRegex(pattern: string, caseInsensitive = false, multiline = false): RegExp {
  const flags = `${caseInsensitive ? "i" : ""}${multiline ? "gs" : ""}`;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegex(pattern), flags);
  }
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  return expandBracePatterns(pattern.replace(/\\/g, "/")).some((expanded) => globToRegExp(expanded).test(normalizedPath));
}

function expandBracePatterns(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) {
    return [pattern];
  }
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]
    .split(",")
    .flatMap((option) => expandBracePatterns(`${before}${option.trim()}${after}`));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
