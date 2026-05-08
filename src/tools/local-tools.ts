import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
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
import type { LocalToolContext, ToolAction, ToolResult, WorkspaceChangeMetadata } from "./types.js";

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

type ShellCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
};

const readSnapshots = new Map<string, ReadSnapshot>();
const todoStates = new Map<string, Array<{ content: string; activeForm?: string; status: "pending" | "in_progress" | "completed" }>>();
const writeLocks = new Map<string, { holder: string; acquiredAt: string }>();

export function normalizeToolAction(inputs: Record<string, unknown>, capability?: string): ToolAction {
  const rawAction = String(inputs.action ?? capability ?? "").trim();
  const action = normalizeActionName(rawAction);
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
      maxMatches: numberInput(inputs.maxMatches ?? inputs.max_matches ?? inputs.head_limit),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines ?? inputs.context ?? inputs["-C"])
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
  if (action === "blackboard.write") {
    return {
      type: "blackboard.write",
      key: requiredStringInput(inputs.key, "BlackboardWrite requires key"),
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
      throw new Error("BlackboardRead requires entry_id or key");
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
  if (action === "agent.delegate") {
    return {
      type: "agent.delegate",
      capability: requiredStringInput(inputs.capability ?? inputs.subagent_type ?? inputs.agent_type ?? (isVisibleAgentAction ? AGENT_TOOL_DEFAULT_CAPABILITY : undefined), "agent.delegate requires capability"),
      task: requiredStringInput(inputs.task ?? inputs.prompt ?? inputs.description ?? inputs.objective, "agent.delegate requires task"),
      context: optionalStringInput(inputs.context),
      preferred_agent_spec_id: optionalStringInput(inputs.preferred_agent_spec_id ?? inputs.agent_spec_id ?? inputs.agent ?? inputs.subagent_type),
      preferred_mode: agentInvocationModeInput(inputs.preferred_mode ?? inputs.invocation_mode ?? inputs.mode),
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
    return webFetch(action);
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
  if (action.type === "agent.delegate") {
    if (!context.delegate) {
      throw new Error("agent.delegate is only available within a swarm agent process");
    }
    return context.delegate(action);
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
  rememberReadSnapshot(resolved, raw, targetInfo.mtimeMs, context, {
    fullView: startLine === 1 && endLine === totalLines && !truncated,
    startLine,
    endLine,
    totalLines,
    truncated
  });
  const path = displayPath(resolved, context.workspace);
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
  const regex = compileSearchRegex(action.pattern);
  const maxMatches = Math.max(1, action.maxMatches ?? 100);
  const contextLines = Math.max(0, action.contextLines ?? 0);
  const files = await collectFiles(root, context, {
    maxFiles: 20_000,
    maxDepth: 20,
    filter: (file) => !action.include || matchesGlob(file.display, action.include) || matchesGlob(basename(file.display), action.include)
  });
  const matches: unknown[] = [];
  for (const file of files) {
    if (matches.length >= maxMatches) {
      break;
    }
    const text = await readTextIfPossible(file.path);
    if (text === undefined) {
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
        before: contextLines ? lines.slice(Math.max(0, index - contextLines), index) : undefined,
        after: contextLines ? lines.slice(index + 1, index + 1 + contextLines) : undefined
      });
      if (matches.length >= maxMatches) {
        break;
      }
    }
  }
  return {
    action: action.type,
    status: "success",
    summary: `found ${matches.length} matches for ${action.pattern}`,
    data: matches,
    metadata: {
      root: displayPath(root, context.workspace),
      requestedRoot: action.root || "."
    }
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
    await assertWritePrecondition(resolved, context);
    const original = await readFile(resolved, "utf8");
    let next: string;
    if (action.operation === "insert") {
      const insert = action.content ?? action.newText ?? "";
      if (!insert) {
        throw new Error("file.edit insert requires content");
      }
      const lines = original.split(/\r?\n/);
      if (action.line === undefined || action.line === -1) {
        next = `${original}${original.endsWith("\n") ? "" : "\n"}${insert}`;
      } else {
        const index = Math.max(0, Math.min(lines.length, action.line - 1));
        lines.splice(index, 0, insert);
        next = lines.join("\n");
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

function fileTargetKind(info: Pick<Awaited<ReturnType<typeof stat>>, "isDirectory" | "isFile">): string {
  if (info.isDirectory()) {
    return "directory";
  }
  if (info.isFile()) {
    return "file";
  }
  return "non-file";
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
  if (currentInfo.mtimeMs !== snapshot.mtimeMs || currentHash !== snapshot.hash) {
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

async function writeBlackboard(action: Extract<ToolAction, { type: "blackboard.write" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("BlackboardWrite is only available inside a Swarm runtime session");
  }
  const entry = await context.blackboard.write(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `blackboard.write ${entry.key}`,
    content: renderBlackboardEntries([entry]),
    data: { entry }
  };
}

async function readBlackboard(action: Extract<ToolAction, { type: "blackboard.read" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("BlackboardRead is only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.read(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `blackboard.read returned ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    content: renderBlackboardEntries(entries),
    data: { entries }
  };
}

async function searchBlackboard(action: Extract<ToolAction, { type: "blackboard.search" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("BlackboardSearch is only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.search(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `blackboard.search returned ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    content: renderBlackboardEntries(entries),
    data: { entries }
  };
}

async function listBlackboard(action: Extract<ToolAction, { type: "blackboard.list" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!context.blackboard) {
    throw new Error("BlackboardList is only available inside a Swarm runtime session");
  }
  const entries = await context.blackboard.list(action, blackboardToolContext(context));
  return {
    action: action.type,
    status: "success",
    summary: `blackboard.list returned ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
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

function renderBlackboardEntries(entries: import("../protocol/types.js").BlackboardEntry[]): string {
  if (entries.length === 0) {
    return "(no blackboard entries)";
  }
  return entries.map((entry) => [
    `${entry.entry_id} ${entry.key} [${entry.type}] v${entry.version}`,
    `created_by=${entry.created_by.agent_id ?? entry.created_by.role ?? entry.created_by.capability ?? "unknown"} visibility=${entry.visibility} tags=${(entry.tags ?? []).join(",") || "-"}`,
    JSON.stringify(entry.value, null, 2)
  ].join("\n")).join("\n\n");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const result = await runShellCommand(action.command, { cwd, timeoutMs, maxOutputBytes });

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
        timeoutMs
      },
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
  const succeeded = result.exitCode === 0 && !result.timedOut;
  const errorCode = succeeded ? undefined : classifyProcessError(result);
  return {
    action: action.type,
    status: succeeded ? "success" : "failed",
    summary: result.timedOut
      ? `command timed out after ${timeoutMs}ms`
      : `command exited ${result.exitCode ?? result.signal ?? "unknown"}`,
    content,
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
      truncated: result.truncated
    }
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
    data: {
      process: result.process,
      bytesTotal: result.bytesTotal,
      bytesRead: result.bytesRead,
      truncated: result.truncated
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
    data: {
      process: result.process,
      matches: result.matches,
      totalMatches: result.totalMatches,
      truncated: result.truncated
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
  const hits = filterSearchHits(dedupeSearchHits([...instant.hits, ...htmlHits]), allowedDomains, blockedDomains).slice(0, 10);
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
        provider: "duckduckgo-fallback",
        durationSeconds,
        fallbackReason,
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
      provider: "duckduckgo-fallback",
      durationSeconds,
      fallbackReason,
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
    return "Retry with a longer timeout or a narrower command that emits less output.";
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

async function webFetch(action: Extract<ToolAction, { type: "web.fetch" }>): Promise<ToolResult> {
  if (!action.url.trim()) {
    throw new Error("web.fetch requires url");
  }
  const timeoutMs = Math.max(1000, action.timeoutMs ?? 30_000);
  const maxBytes = Math.max(1024, action.maxBytes ?? 500_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(action.url, { signal: controller.signal, redirect: "follow" });
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
        url: action.url,
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
      summary: `fetched ${action.url} — ${response.status} ${contentType} (${response.headers.get("content-length") ?? "?"} bytes, non-text, body not returned)`,
      ...failure,
      data: {
        url: action.url,
        status: response.status,
        contentType,
        contentLength: response.headers.get("content-length")
      }
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const truncated = buffer.length > maxBytes;
  const content = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : buffer.toString("utf8");

  return {
    action: "web.fetch",
    status: response.ok ? "success" : "failed",
    summary: `fetched ${action.url} — ${response.status} ${contentType}, ${buffer.length} bytes${truncated ? " (truncated)" : ""}`,
    content: action.prompt ? webFetchPromptedContent(content, action.prompt, action.url) : content,
    ...(response.ok ? undefined : webFetchHttpFailureMetadata(response.status, response.statusText)),
    data: {
      url: action.url,
      finalUrl: response.url !== action.url ? response.url : undefined,
      status: response.status,
      contentType,
      bytes: buffer.length,
      prompt: action.prompt,
      truncated
    }
  };
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
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.lint) {
      commands.push(`npm run lint`);
    } else {
      commands.push(`npx eslint . --ext .ts,.tsx,.js,.jsx 2>&1 || true`);
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
  const probes = [
    { file: "package.json", kind: "node" },
    { file: "tsconfig.json", kind: "typescript" },
    { file: "pyproject.toml", kind: "python" },
    { file: "Cargo.toml", kind: "rust" },
    { file: "go.mod", kind: "go" },
    { file: "pom.xml", kind: "java-maven" },
    { file: "build.gradle", kind: "java-gradle" }
  ];
  const matches: Array<{ file: string; kind: string }> = [];
  for (const probe of probes) {
    const fullPath = resolve(root, probe.file);
    try {
      assertReadableByDenyRules(fullPath, context);
      const info = await stat(fullPath);
      if (info.isFile()) {
        matches.push({ file: displayPath(fullPath, context.workspace), kind: probe.kind });
      }
    } catch {
      // Missing probe files are normal.
    }
  }
  return {
    action: action.type,
    status: "success",
    summary: matches.length ? `detected ${matches.map((item) => item.kind).join(", ")}` : "no known project manifests detected",
    data: {
      root: displayPath(root, context.workspace),
      kinds: [...new Set(matches.map((item) => item.kind))],
      manifests: matches
    }
  };
}

/** Shared shell runner used by tools that wrap shell commands. */
async function runShellCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number }
): Promise<ShellCommandResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (extra: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode: extra.exitCode ?? null, signal: extra.signal ?? null, stdout, stderr, timedOut, truncated, error: extra.error });
    };

    const child = spawn(shell, args, { cwd: options.cwd, env: process.env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const current = stream === "stdout" ? stdout : stderr;
      const next = current + text;
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

function normalizeActionName(action: string): ToolAction["type"] {
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
  if (["TodoWrite", "todo", "todo_write", "todo.write", "tool.todo.write"].includes(action)) {
    return "todo.write";
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
  if (["Bash", "bash", "shell", "tool.shell.exec", "shell.exec"].includes(action)) {
    return "shell.exec";
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
  if (["ProcessStop", "process_stop", "process.stop", "TaskStop", "KillShell", "background.stop"].includes(action)) {
    return "process.stop";
  }
  if (["WebSearch", "web_search", "web.search"].includes(action)) {
    return "web.search";
  }
  if (["WebFetch", "web_fetch", "web.fetch", "fetch"].includes(action)) {
    return "web.fetch";
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
  if (["Agent", "Task", "agent_delegate", "agent.delegate", "delegate"].includes(action)) {
    return "agent.delegate";
  }
  return action as ToolAction["type"];
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
  return undefined;
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

function numberInput(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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

function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(escapeRegex(pattern));
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
