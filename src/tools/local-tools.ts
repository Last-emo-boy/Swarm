import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  assertReadableByDenyRules,
  displayPath,
  resolveReadablePath,
  resolveShellCwd,
  resolveWritablePath
} from "./permissions.js";
import type { LocalToolContext, ToolAction, ToolResult, WorkspaceChangeMetadata } from "./types.js";

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
const todoStates = new Map<string, Array<{ content: string; status: "pending" | "in_progress" | "completed" }>>();
const writeLocks = new Map<string, { holder: string; acquiredAt: string }>();

export function normalizeToolAction(inputs: Record<string, unknown>, capability?: string): ToolAction {
  const rawAction = String(inputs.action ?? capability ?? "").trim();
  const action = normalizeActionName(rawAction);
  if (action === "file.read") {
    return {
      type: "file.read",
      path: optionalStringInput(inputs.path),
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
      root: stringInput(inputs.root || "."),
      pattern: stringInput(inputs.pattern || inputs.glob || "**/*"),
      maxResults: numberInput(inputs.maxResults ?? inputs.max_results),
      maxDepth: numberInput(inputs.maxDepth ?? inputs.max_depth)
    };
  }
  if (action === "file.grep") {
    return {
      type: "file.grep",
      root: stringInput(inputs.root || "."),
      pattern: stringInput(inputs.pattern || inputs.query),
      include: optionalStringInput(inputs.include),
      maxMatches: numberInput(inputs.maxMatches ?? inputs.max_matches),
      contextLines: numberInput(inputs.contextLines ?? inputs.context_lines)
    };
  }
  if (action === "file.stat") {
    return { type: "file.stat", path: stringInput(inputs.path) };
  }
  if (action === "file.write") {
    return { type: "file.write", path: stringInput(inputs.path), content: stringInput(inputs.content) };
  }
  if (action === "file.edit") {
    return {
      type: "file.edit",
      path: stringInput(inputs.path),
      operation: String(inputs.operation ?? inputs.command ?? "str_replace") === "insert" ? "insert" : "str_replace",
      oldText: optionalStringInput(inputs.oldText ?? inputs.old_text ?? inputs.oldString ?? inputs.old_string),
      newText: optionalStringInput(inputs.newText ?? inputs.new_text ?? inputs.newString ?? inputs.new_string),
      line: numberInput(inputs.line ?? inputs.insertLine ?? inputs.insert_line),
      content: optionalStringInput(inputs.content ?? inputs.insertText ?? inputs.insert_text)
    };
  }
  if (action === "todo.write") {
    return {
      type: "todo.write",
      todos: todoListInput(inputs.todos)
    };
  }
  if (action === "shell.exec") {
    return {
      type: "shell.exec",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms),
      maxOutputBytes: numberInput(inputs.maxOutputBytes ?? inputs.max_output_bytes)
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
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms),
      maxBytes: numberInput(inputs.maxBytes ?? inputs.max_bytes)
    };
  }
  if (action === "code.test") {
    return {
      type: "code.test",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms)
    };
  }
  if (action === "code.lint") {
    return {
      type: "code.lint",
      root: optionalStringInput(inputs.root ?? inputs.path),
      include: optionalStringInput(inputs.include)
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
  if (action === "package.install") {
    return {
      type: "package.install",
      command: stringInput(inputs.command),
      cwd: optionalStringInput(inputs.cwd),
      timeoutMs: numberInput(inputs.timeoutMs ?? inputs.timeout_ms)
    };
  }
  if (action === "solidity.compile") {
    return {
      type: "solidity.compile",
      cwd: optionalStringInput(inputs.cwd),
      framework: String(inputs.framework ?? "hardhat") === "solc" ? "solc" : String(inputs.framework) === "foundry" ? "foundry" : "hardhat"
    };
  }
  if (action === "agent.delegate") {
    return {
      type: "agent.delegate",
      capability: stringInput(inputs.capability),
      task: stringInput(inputs.task ?? inputs.description ?? inputs.objective),
      context: optionalStringInput(inputs.context),
      preferred_agent_spec_id: optionalStringInput(inputs.preferred_agent_spec_id ?? inputs.agent_spec_id ?? inputs.agent),
      preferred_mode: agentInvocationModeInput(inputs.preferred_mode ?? inputs.invocation_mode ?? inputs.mode),
      file_scope: stringArrayInput(inputs.file_scope ?? inputs.fileScope ?? inputs.paths)
    };
  }
  throw new Error(`Unsupported tool action: ${rawAction || "(empty)"}`);
}

export async function runLocalTool(action: ToolAction, context: LocalToolContext): Promise<ToolResult> {
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
  if (action.type === "todo.write") {
    return writeTodos(action, context);
  }
  if (action.type === "shell.exec") {
    return executeShell(action, context);
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
  if (action.type === "code.test") {
    return executeCodeTest(action, context);
  }
  if (action.type === "code.lint") {
    return executeCodeLint(action, context);
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
  if (action.type === "package.install") {
    return executePackageInstall(action, context);
  }
  if (action.type === "solidity.compile") {
    return executeSolidityCompile(action, context);
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
    const failures = results.filter((result) => result.metadata?.error).length;
    return {
      action: action.type,
      status: failures === results.length ? "failed" : failures > 0 ? "partial" : "success",
      summary: `read ${results.length - failures}/${results.length} files${failures ? `, ${failures} failed` : ""}`,
      content: results
        .map((result) =>
          result.metadata?.error
            ? `--- ${String(result.metadata.path ?? "file")} ---\nERROR: ${String(result.metadata.error)}`
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
  const info = await stat(resolved);
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
  rememberReadSnapshot(resolved, raw, info.mtimeMs, context, {
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

async function writeLocalFile(action: Extract<ToolAction, { type: "file.write" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
  const release = acquireWriteLock(resolved, context);
  try {
    const existed = await stat(resolved).then((info) => info.isFile()).catch(() => false);
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

async function editLocalFile(action: Extract<ToolAction, { type: "file.edit" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
  const release = acquireWriteLock(resolved, context);
  try {
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
      if (matches !== 1) {
        throw new Error(`file.edit str_replace requires exactly one match; found ${matches}. Use file.grep or file.read to narrow the replacement target, then retry with a unique oldText.`);
      }
      next = original.replace(action.oldText, action.newText ?? "");
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
  const cwd = resolveShellCwd(action.cwd, context);
  const timeoutMs = Math.max(1000, action.timeoutMs ?? 120_000);
  const maxOutputBytes = Math.max(1024, action.maxOutputBytes ?? 200_000);
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
        error: result.error
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
  return {
    action: action.type,
    status: result.exitCode === 0 && !result.timedOut ? "success" : "failed",
    summary: `command exited ${result.exitCode ?? result.signal ?? "unknown"}${result.timedOut ? " after timeout" : ""}`,
    content,
    errorCode: result.exitCode === 0 && !result.timedOut ? undefined : classifyProcessError(result),
    retryable: result.exitCode === 0 && !result.timedOut ? undefined : isRetryableProcessError(result),
    recoverable: result.exitCode === 0 && !result.timedOut ? undefined : true,
    recoverySuggestion: result.exitCode === 0 && !result.timedOut ? undefined : recoverySuggestionForToolFailure(action.type, classifyProcessError(result), content, result),
    metadata: {
      cwd: displayPath(cwd, context.workspace),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated
    }
  };
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
    return {
      action: "web.fetch",
      status: response.ok ? "success" : "failed",
      summary: `fetched ${action.url} — ${response.status} ${contentType} (${response.headers.get("content-length") ?? "?"} bytes, non-text, body not returned)`,
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
    content,
    data: {
      url: action.url,
      finalUrl: response.url !== action.url ? response.url : undefined,
      status: response.status,
      contentType,
      bytes: buffer.length,
      truncated
    }
  };
}

async function executeCodeTest(action: Extract<ToolAction, { type: "code.test" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.command.trim()) {
    throw new Error("code.test requires command");
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
    results.push({
      action: "code.lint",
      status: shellResult.exitCode === 0 && !shellResult.timedOut && !shellResult.error ? "success" : "failed",
      summary: `lint command exited ${shellResult.exitCode}`,
      content: [`$ ${cmd}`, shellResult.stdout].filter(Boolean).join("\n").trim(),
      data: {
        command: cmd,
        exitCode: shellResult.exitCode,
        timedOut: shellResult.timedOut,
        truncated: shellResult.truncated
      }
    });
  }

  return {
    action: "code.lint",
    status: results.some((result) => result.status === "failed") ? "failed" : "success",
    summary: `ran ${results.length} linter(s)`,
    content: results.map((r) => r.content).filter(Boolean).join("\n\n"),
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

async function executeSolidityCompile(action: Extract<ToolAction, { type: "solidity.compile" }>, context: LocalToolContext): Promise<ToolResult> {
  const cwd = resolveShellCwd(action.cwd, context);
  let cmd: string;
  if (action.framework === "foundry") {
    cmd = "forge build --no-auto-detect 2>&1";
  } else if (action.framework === "solc") {
    cmd = "solc --bin --abi contracts/*.sol 2>&1 || true";
  } else {
    cmd = "npx hardhat compile 2>&1 || true";
  }

  const result = await runShellCommand(cmd, { cwd, timeoutMs: 300_000, maxOutputBytes: 300_000 });

  if (result.error) {
    return {
      action: "solidity.compile",
      status: "failed",
      summary: `compilation failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      errors: [result.error],
      metadata: { cwd: displayPath(cwd, context.workspace), framework: action.framework ?? "hardhat", error: result.error }
    };
  }

  const hasErrors = result.stderr.toLowerCase().includes("error") || result.stdout.toLowerCase().includes("error ");
  return {
    action: "solidity.compile",
    status: !hasErrors && result.exitCode === 0 && !result.timedOut ? "success" : "failed",
    summary: hasErrors ? "compilation produced errors" : result.exitCode === 0 ? "compilation succeeded" : `compilation finished (exit ${result.exitCode})`,
    content: [`$ ${cmd}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n").trim(),
    data: {
      cwd: displayPath(cwd, context.workspace),
      framework: action.framework ?? "hardhat",
      exitCode: result.exitCode,
      hasErrors,
      timedOut: result.timedOut,
      truncated: result.truncated
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
  if (code === "ENOTDIR") return "INVALID_INPUT";
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
  if (["read_file", "tool.file.read", "file.read"].includes(action)) {
    return "file.read";
  }
  if (["list_files", "tool.file.list", "file.list", "ls"].includes(action)) {
    return "file.list";
  }
  if (["glob", "tool.file.glob", "file.glob"].includes(action)) {
    return "file.glob";
  }
  if (["grep", "tool.file.grep", "file.grep"].includes(action)) {
    return "file.grep";
  }
  if (["stat", "tool.file.stat", "file.stat"].includes(action)) {
    return "file.stat";
  }
  if (["write_file", "tool.file.write", "file.write"].includes(action)) {
    return "file.write";
  }
  if (["edit_file", "tool.file.edit", "file.edit"].includes(action)) {
    return "file.edit";
  }
  if (["todo", "todo_write", "todo.write", "tool.todo.write"].includes(action)) {
    return "todo.write";
  }
  if (["bash", "shell", "tool.shell.exec", "shell.exec"].includes(action)) {
    return "shell.exec";
  }
  if (["web_search", "web.search"].includes(action)) {
    return "web.search";
  }
  if (["web_fetch", "web.fetch", "fetch"].includes(action)) {
    return "web.fetch";
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
  if (["solidity_compile", "solidity.compile", "compile"].includes(action)) {
    return "solidity.compile";
  }
  if (["agent_delegate", "agent.delegate", "delegate"].includes(action)) {
    return "agent.delegate";
  }
  return action as ToolAction["type"];
}

function stringInput(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
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

function todoListInput(value: unknown): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> {
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
