import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  assertReadableByDenyRules,
  displayPath,
  resolveReadablePath,
  resolveShellCwd,
  resolveWritablePath
} from "./permissions.js";
import type { LocalToolContext, ToolAction, ToolResult } from "./types.js";

type WalkedFile = {
  path: string;
  display: string;
};

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
    return { type: "web.search", query: stringInput(inputs.query) };
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
    return {
      type: "git.branch",
      cwd: optionalStringInput(inputs.cwd),
      action: String(inputs.action ?? "list") === "create" ? "create" : String(inputs.action) === "switch" ? "switch" : "list",
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
      context: optionalStringInput(inputs.context)
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
  if (action.type === "shell.exec") {
    return executeShell(action, context);
  }
  if (!context.settings.tools.webSearch) {
    throw new Error("Web search is disabled by ~/.swarm/settings.json");
  }
  if (action.type === "web.search") {
    return webSearch(action.query);
  }
  if (action.type === "web.fetch") {
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
  if (result.content) {
    return result.content;
  }
  return JSON.stringify(result.data ?? result.metadata ?? {}, null, 2);
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
            summary: `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
            content: "",
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
      summary: `read ${results.length - failures}/${results.length} files${failures ? `, ${failures} failed` : ""}`,
      content: results
        .map((result) =>
          result.metadata?.error
            ? `--- ${String(result.metadata.path ?? "file")} ---\nERROR: ${String(result.metadata.error)}`
            : `--- ${String(result.metadata?.path ?? "file")} ---\n${result.content ?? ""}`
        )
        .join("\n\n"),
      data: results.map((result) => result.metadata)
    };
  }
  return readSingleLocalFile({ ...action, path: paths[0], paths: undefined }, context);
}

async function readSingleLocalFile(
  action: Extract<ToolAction, { type: "file.read" }> & { path: string },
  context: LocalToolContext
): Promise<ToolResult> {
  const resolved = resolveReadablePath(action.path, context);
  const raw = await readFile(resolved, "utf8");
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, action.startLine ?? 1);
  const requestedEnd = action.endLine === -1 || action.endLine === undefined ? totalLines : action.endLine;
  const endLine = Math.max(startLine - 1, Math.min(totalLines, requestedEnd));
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  const maxBytes = Math.max(1, action.maxBytes ?? 200_000);
  const buffer = Buffer.from(selected, "utf8");
  const truncated = buffer.length > maxBytes;
  const content = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : selected;
  const path = displayPath(resolved, context.workspace);
  return {
    action: action.type,
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
    summary: `matched ${files.length} files for ${action.pattern}`,
    data: files.map((file) => file.display)
  };
}

async function grepLocalFiles(action: Extract<ToolAction, { type: "file.grep" }>, context: LocalToolContext): Promise<ToolResult> {
  if (!action.pattern) {
    throw new Error("file.grep requires pattern");
  }
  const root = resolveReadablePath(action.root || ".", context);
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
    summary: `found ${matches.length} matches for ${action.pattern}`,
    data: matches
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
    summary: `${data.path}: ${data.type}, ${data.bytes} bytes${lineCount ? `, ${lineCount} lines` : ""}`,
    data
  };
}

async function writeLocalFile(action: Extract<ToolAction, { type: "file.write" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, action.content, "utf8");
  const bytes = Buffer.byteLength(action.content, "utf8");
  const path = displayPath(resolved, context.workspace);
  return {
    action: action.type,
    summary: `wrote ${bytes} bytes to ${path}`,
    data: { path, bytes }
  };
}

async function editLocalFile(action: Extract<ToolAction, { type: "file.edit" }>, context: LocalToolContext): Promise<ToolResult> {
  const resolved = resolveWritablePath(action.path, context);
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
      throw new Error(`file.edit str_replace requires exactly one match; found ${matches}`);
    }
    next = original.replace(action.oldText, action.newText ?? "");
  }
  await writeFile(resolved, next, "utf8");
  const path = displayPath(resolved, context.workspace);
  return {
    action: action.type,
    summary: `edited ${path}`,
    data: {
      path,
      beforeBytes: Buffer.byteLength(original, "utf8"),
      afterBytes: Buffer.byteLength(next, "utf8")
    }
  };
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
      summary: `command failed: ${result.error}`,
      content,
      metadata: {
        cwd: displayPath(cwd, context.workspace),
        error: result.error
      }
    };
  }

  const content = [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    action: action.type,
    summary: `command exited ${result.exitCode ?? result.signal ?? "unknown"}${result.timedOut ? " after timeout" : ""}`,
    content,
    metadata: {
      cwd: displayPath(cwd, context.workspace),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated
    }
  };
}

async function webSearch(query: string): Promise<ToolResult> {
  if (!query.trim()) {
    return { action: "web.search", summary: "web search returned 0 results", data: { query, results: [] } };
  }
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
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };
  const related = (json.RelatedTopics ?? [])
    .filter((item) => item.Text || item.FirstURL)
    .slice(0, 5)
    .map((item) => ({ title: item.Text, url: item.FirstURL }));
  return {
    action: "web.search",
    summary: `web search returned ${related.length + (json.AbstractText ? 1 : 0)} results`,
    data: {
      query,
      abstract: json.AbstractText ?? "",
      abstract_url: json.AbstractURL ?? "",
      related
    }
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
      summary: `web.fetch failed: ${isTimeout ? "timeout" : reason}`,
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
      summary: `test command failed: ${result.error}`,
      content: `$ ${action.command}\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  const passed = result.exitCode === 0;
  return {
    action: "code.test",
    summary: passed ? "tests passed" : `tests failed (exit ${result.exitCode})`,
    content: [`$ ${action.command}`, result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n").trim(),
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
  const root = resolveReadablePath(action.root ?? ".", context);

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
      summary: "no recognized linter configuration found",
      data: { cwd: displayPath(root, context.workspace) }
    };
  }

  const results: ToolResult[] = [];
  for (const cmd of commands) {
    const shellResult = await runShellCommand(cmd, { cwd: root, timeoutMs: 120_000, maxOutputBytes: 300_000 });
    results.push({
      action: "code.lint",
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
      summary: `git status failed: ${result.error}`,
      content: `$ git status --porcelain --branch\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const staged = lines.filter((l) => !l.startsWith("##") && l[1] !== " " && l[2] !== " ").length;
  const unstaged = lines.filter((l) => l[1] === " " || l[2] === " ").length;
  const branchLine = lines.find((l) => l.startsWith("##"));

  return {
    action: "git.status",
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
      summary: `git diff failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  return {
    action: "git.diff",
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
      summary: `git log failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  const commits = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    action: "git.log",
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
    summary: `git branch failed: ${error}`,
    content: `$ ${cmd}\nERROR: ${error}`,
    metadata: { cwd: displayPath(cwd, context.workspace), error }
  });

  if (action.action === "list" || !action.action) {
    const cmd = "git branch --list";
    const result = await runShellCommand(cmd, { cwd, timeoutMs: 30_000, maxOutputBytes: 100_000 });
    if (result.error) return cmdError(cmd, result.error);
    const branches = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return {
      action: "git.branch",
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
      summary: `install failed: ${result.error}`,
      content: `$ ${action.command}\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), error: result.error }
    };
  }

  return {
    action: "package.install",
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
      summary: `compilation failed: ${result.error}`,
      content: `$ ${cmd}\nERROR: ${result.error}`,
      metadata: { cwd: displayPath(cwd, context.workspace), framework: action.framework ?? "hardhat", error: result.error }
    };
  }

  const hasErrors = result.stderr.toLowerCase().includes("error") || result.stdout.toLowerCase().includes("error ");
  return {
    action: "solidity.compile",
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
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; error?: string }> {
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

function stringArrayInput(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => String(item)).filter((item) => item.trim());
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
