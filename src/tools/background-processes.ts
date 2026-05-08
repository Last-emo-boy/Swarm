import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { getSwarmPaths } from "../config/settings.js";

export type BackgroundProcessStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

export type BackgroundProcessRecord = {
  processId: string;
  sessionId: string;
  taskId?: string;
  command: string;
  cwd: string;
  description?: string;
  pid?: number;
  shell: string;
  status: BackgroundProcessStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: string;
  endedAt?: string;
  logPath: string;
  metadataPath: string;
  timeoutMs?: number;
  maxLogBytes: number;
  lastError?: string;
};

export type BackgroundProcessStartInput = {
  command: string;
  cwd: string;
  sessionId?: string;
  taskId?: string;
  description?: string;
  timeoutMs?: number;
  maxLogBytes?: number;
};

export type BackgroundProcessTail = {
  process: BackgroundProcessRecord;
  content: string;
  bytesTotal: number;
  bytesRead: number;
  truncated: boolean;
};

export type BackgroundProcessGrep = {
  process: BackgroundProcessRecord;
  matches: string[];
  totalMatches: number;
  truncated: boolean;
};

const DEFAULT_SESSION_ID = "global";
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
const PROCESS_POLL_INTERVAL_MS = 5_000;

const activeProcesses = new Map<string, {
  child: ChildProcess;
  sizeWatchdog?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
}>();

export async function startBackgroundProcess(input: BackgroundProcessStartInput): Promise<BackgroundProcessRecord> {
  const sessionId = sanitizePathPart(input.sessionId ?? DEFAULT_SESSION_ID);
  const processId = `proc_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const dir = processDir(sessionId);
  await mkdir(dir, { recursive: true });
  const logPath = join(dir, `${processId}.log`);
  const metadataPath = join(dir, `${processId}.json`);
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", input.command]
    : ["-lc", input.command];
  const maxLogBytes = Math.max(1024 * 1024, input.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES);
  const startedAt = new Date().toISOString();

  await writeFile(logPath, [
    `[swarm] started ${startedAt}`,
    `[swarm] cwd ${input.cwd}`,
    `[swarm] command ${input.command}`,
    ""
  ].join("\n"), "utf8");

  const outputHandle = await open(logPath, "a");
  const record: BackgroundProcessRecord = {
    processId,
    sessionId,
    taskId: input.taskId,
    command: input.command,
    cwd: input.cwd,
    description: input.description,
    shell,
    status: "running",
    startedAt,
    logPath,
    metadataPath,
    timeoutMs: input.timeoutMs,
    maxLogBytes
  };

  await writeRecord(record);

  try {
    const child = spawn(shell, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", outputHandle.fd, outputHandle.fd],
      detached: true,
      windowsHide: true
    });
    record.pid = child.pid;
    await writeRecord(record);
    await outputHandle.close().catch(() => undefined);

    const active = {
      child,
      sizeWatchdog: startSizeWatchdog(record),
      timeout: input.timeoutMs ? startTimeout(record, child, input.timeoutMs) : undefined
    };
    activeProcesses.set(processId, active);

    child.on("error", (error) => {
      void updateTerminalRecord(processId, {
        status: "failed",
        lastError: error.message
      });
    });
    child.on("exit", (exitCode, signal) => {
      const current = activeProcesses.get(processId);
      if (current?.timeout) clearTimeout(current.timeout);
      if (current?.sizeWatchdog) clearInterval(current.sizeWatchdog);
      activeProcesses.delete(processId);
      void readRecord(processId, sessionId).then((latest) => {
        if (latest.status === "stopped") {
          return latest;
        }
        return updateTerminalRecord(processId, {
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          signal
        }, sessionId);
      }).catch(() => undefined);
    });
    child.unref();
    return record;
  } catch (error) {
    await outputHandle.close().catch(() => undefined);
    return updateTerminalRecord(processId, {
      status: "failed",
      lastError: error instanceof Error ? error.message : String(error)
    }, sessionId);
  }
}

export async function getBackgroundProcess(processId: string, sessionId?: string): Promise<BackgroundProcessRecord> {
  const record = await readRecord(processId, sessionId);
  return refreshRecord(record);
}

export async function listBackgroundProcesses(input: {
  sessionId?: string;
  status?: BackgroundProcessStatus;
  limit?: number;
} = {}): Promise<BackgroundProcessRecord[]> {
  const roots = input.sessionId
    ? [processDir(sanitizePathPart(input.sessionId))]
    : await listProcessDirs();
  const records: BackgroundProcessRecord[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await readdir(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = await refreshRecord(parseRecord(await readFile(join(root, file), "utf8")));
        if (!input.status || record.status === input.status) {
          records.push(record);
        }
      } catch {
        // Ignore corrupt or racing metadata files.
      }
    }
  }
  return records
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, input.limit ?? 50));
}

export async function stopBackgroundProcess(processId: string, sessionId?: string): Promise<BackgroundProcessRecord> {
  const record = await readRecord(processId, sessionId);
  const active = activeProcesses.get(record.processId);
  if (record.status !== "running") {
    return record;
  }
  if (active?.timeout) clearTimeout(active.timeout);
  if (active?.sizeWatchdog) clearInterval(active.sizeWatchdog);

  if (record.pid !== undefined) {
    await killProcessTree(record.pid).catch((error: unknown) => {
      record.lastError = error instanceof Error ? error.message : String(error);
    });
  }
  activeProcesses.delete(record.processId);
  return updateTerminalRecord(record.processId, {
    status: "stopped",
    signal: "SIGTERM",
    lastError: record.lastError
  }, record.sessionId);
}

export async function readBackgroundProcessTail(input: {
  processId: string;
  sessionId?: string;
  maxBytes?: number;
  lines?: number;
}): Promise<BackgroundProcessTail> {
  const processRecord = await getBackgroundProcess(input.processId, input.sessionId);
  const maxBytes = Math.max(1024, Math.min(input.maxBytes ?? DEFAULT_TAIL_BYTES, 1024 * 1024));
  const info = await stat(processRecord.logPath).catch(() => ({ size: 0 }));
  const bytesTotal = info.size;
  const start = Math.max(0, bytesTotal - maxBytes);
  const bytesRead = bytesTotal - start;
  let content = "";
  if (bytesRead > 0) {
    const handle = await open(processRecord.logPath, "r");
    try {
      const buffer = Buffer.alloc(bytesRead);
      await handle.read(buffer, 0, bytesRead, start);
      content = buffer.toString("utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  const lines = Math.max(1, input.lines ?? 120);
  const selected = content.split(/\r?\n/).slice(-lines).join("\n");
  return {
    process: processRecord,
    content: start > 0 ? `[${start} earlier bytes omitted]\n${selected}` : selected,
    bytesTotal,
    bytesRead,
    truncated: start > 0
  };
}

export async function grepBackgroundProcessLog(input: {
  processId: string;
  sessionId?: string;
  pattern: string;
  maxMatches?: number;
  contextLines?: number;
}): Promise<BackgroundProcessGrep> {
  const processRecord = await getBackgroundProcess(input.processId, input.sessionId);
  const regex = compileSearchRegex(input.pattern);
  const maxMatches = Math.max(1, Math.min(input.maxMatches ?? 50, 500));
  const contextLines = Math.max(0, Math.min(input.contextLines ?? 0, 10));
  const matches: string[] = [];
  const emitted = new Set<number>();
  const previous: Array<{ number: number; text: string }> = [];
  let afterRemaining = 0;
  let totalMatches = 0;
  let lineNumber = 0;

  const stream = createReadStream(processRecord.logPath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    lineNumber += 1;
    const isMatch = regex.test(line);
    regex.lastIndex = 0;
    if (isMatch) {
      totalMatches += 1;
      if (matches.length < maxMatches) {
        for (const context of previous) {
          if (!emitted.has(context.number)) {
            emitted.add(context.number);
            matches.push(`${context.number}-${truncateLine(context.text)}`);
          }
        }
        emitted.add(lineNumber);
        matches.push(`${lineNumber}:${truncateLine(line)}`);
      }
      afterRemaining = contextLines;
    } else if (afterRemaining > 0 && matches.length < maxMatches && !emitted.has(lineNumber)) {
      emitted.add(lineNumber);
      matches.push(`${lineNumber}-${truncateLine(line)}`);
      afterRemaining -= 1;
    }

    previous.push({ number: lineNumber, text: line });
    while (previous.length > contextLines) {
      previous.shift();
    }
  }

  return {
    process: processRecord,
    matches,
    totalMatches,
    truncated: totalMatches > maxMatches
  };
}

function startTimeout(record: BackgroundProcessRecord, child: ChildProcess, timeoutMs: number): NodeJS.Timeout {
  const timeout = setTimeout(() => {
    void appendFile(record.logPath, `\n[swarm] timeout after ${timeoutMs}ms; stopping process tree\n`, "utf8").catch(() => undefined);
    if (record.pid !== undefined) {
      void killProcessTree(record.pid);
    } else {
      child.kill();
    }
    void updateTerminalRecord(record.processId, {
      status: "failed",
      lastError: `Process timed out after ${timeoutMs}ms`
    }, record.sessionId);
  }, timeoutMs);
  timeout.unref();
  return timeout;
}

function startSizeWatchdog(record: BackgroundProcessRecord): NodeJS.Timeout {
  const timer = setInterval(() => {
    void stat(record.logPath).then((info) => {
      if (info.size <= record.maxLogBytes) return;
      void appendFile(record.logPath, `\n[swarm] log exceeded ${record.maxLogBytes} bytes; stopping process tree\n`, "utf8").catch(() => undefined);
      if (record.pid !== undefined) {
        void killProcessTree(record.pid);
      }
      void updateTerminalRecord(record.processId, {
        status: "failed",
        lastError: `Log exceeded ${record.maxLogBytes} bytes`
      }, record.sessionId);
    }).catch(() => undefined);
  }, PROCESS_POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

async function refreshRecord(record: BackgroundProcessRecord): Promise<BackgroundProcessRecord> {
  if (record.status !== "running" || activeProcesses.has(record.processId)) {
    return record;
  }
  if (record.pid !== undefined && isPidRunning(record.pid)) {
    return record;
  }
  return updateTerminalRecord(record.processId, {
    status: "unknown",
    lastError: "Process is not tracked by this Swarm runtime and the pid is not running."
  }, record.sessionId);
}

async function updateTerminalRecord(
  processId: string,
  patch: Partial<Pick<BackgroundProcessRecord, "status" | "exitCode" | "signal" | "lastError">>,
  sessionId?: string
): Promise<BackgroundProcessRecord> {
  const record = await readRecord(processId, sessionId);
  const updated: BackgroundProcessRecord = {
    ...record,
    ...patch,
    endedAt: record.endedAt ?? new Date().toISOString()
  };
  await writeRecord(updated);
  return updated;
}

async function readRecord(processId: string, sessionId?: string): Promise<BackgroundProcessRecord> {
  const paths = sessionId
    ? [join(processDir(sanitizePathPart(sessionId)), `${sanitizePathPart(processId)}.json`)]
    : await findRecordPaths(processId);
  for (const path of paths) {
    try {
      return parseRecord(await readFile(path, "utf8"));
    } catch {
      // Try the next matching path.
    }
  }
  throw new Error(`No background process found with ID: ${processId}`);
}

async function findRecordPaths(processId: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of await listProcessDirs()) {
    found.push(join(dir, `${sanitizePathPart(processId)}.json`));
  }
  return found;
}

async function listProcessDirs(): Promise<string[]> {
  const sessionsRoot = resolve(getSwarmPaths().sessionsDir);
  let sessions: string[] = [];
  try {
    sessions = await readdir(sessionsRoot);
  } catch {
    return [];
  }
  return sessions.map((session) => join(sessionsRoot, session, "processes"));
}

async function writeRecord(record: BackgroundProcessRecord): Promise<void> {
  await mkdir(processDir(record.sessionId), { recursive: true });
  await writeFile(record.metadataPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function processDir(sessionId: string): string {
  return join(resolve(getSwarmPaths().sessionsDir), sanitizePathPart(sessionId), "processes");
}

function parseRecord(content: string): BackgroundProcessRecord {
  const parsed = JSON.parse(content) as BackgroundProcessRecord;
  return {
    ...parsed,
    metadataPath: parsed.metadataPath || join(processDir(parsed.sessionId), `${sanitizePathPart(parsed.processId)}.json`)
  };
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await runSignalCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await delay(700);
  if (!isPidRunning(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function runSignalCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 5_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    });
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EPERM";
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 180) || "process";
}

function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateLine(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1197)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
