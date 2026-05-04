import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type DebugLogLevel = "trace" | "debug" | "info" | "warn" | "error";

type LogEntry = {
  ts: string;
  pid: number;
  session_id: string;
  level: DebugLogLevel;
  section: string;
  message: string;
  data?: unknown;
  elapsedMs?: number;
};

type DebugLoggerOptions = {
  sessionId?: string;
  maxBytes?: number;
};

const LEVEL_RANK: Record<DebugLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
};

export class DebugLogger {
  private path: string;
  private readonly minLevel: DebugLogLevel;
  private readonly pid: number;
  private readonly logDir: string;
  private readonly sessionId: string;
  private readonly maxBytes: number;
  private readonly startTimes = new Map<string, number>();
  private part = 1;

  constructor(logDir: string, minLevel: DebugLogLevel = "debug", options: DebugLoggerOptions = {}) {
    this.minLevel = minLevel;
    this.pid = process.pid;
    this.logDir = logDir;
    this.sessionId = sanitizeSessionId(options.sessionId || process.env.SWARM_DEBUG_SESSION_ID || defaultSessionId());
    this.maxBytes = options.maxBytes ?? 1_048_576;
    mkdirSync(logDir, { recursive: true });
    this.path = this.resolvePath();
    this.log("debug", "debug-logger", `Logger started. pid=${this.pid} session=${this.sessionId} level=${minLevel} path=${this.path}`);
  }

  get logPath(): string {
    return this.path;
  }

  log(level: DebugLogLevel, section: string, message: string, data?: unknown, elapsedMs?: number): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      pid: this.pid,
      session_id: this.sessionId,
      level,
      section,
      message
    };
    if (data !== undefined) entry.data = data;
    if (elapsedMs !== undefined) entry.elapsedMs = elapsedMs;

    try {
      const line = `${JSON.stringify(entry)}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
      appendFileSync(this.path, line, "utf8");
    } catch {
      // silently ignore write failures
    }
  }

  private rotateIfNeeded(nextBytes: number): void {
    while (true) {
      const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
      if (currentBytes === 0 || currentBytes + nextBytes <= this.maxBytes) {
        return;
      }
      this.part += 1;
      this.path = this.resolvePath();
    }
  }

  private resolvePath(): string {
    const suffix = this.part === 1 ? "" : `.part-${this.part}`;
    return resolve(this.logDir, `${this.sessionId}${suffix}.log`);
  }

  trace(section: string, message: string, data?: unknown): void {
    this.log("trace", section, message, data);
  }

  debug(section: string, message: string, data?: unknown): void {
    this.log("debug", section, message, data);
  }

  info(section: string, message: string, data?: unknown): void {
    this.log("info", section, message, data);
  }

  warn(section: string, message: string, data?: unknown): void {
    this.log("warn", section, message, data);
  }

  error(section: string, message: string, data?: unknown): void {
    this.log("error", section, message, data);
  }

  /** Start timing an operation. Returns a stop function that logs the elapsed time. */
  time(section: string, label: string): () => void {
    const key = `${section}:${label}`;
    this.startTimes.set(key, performance.now());
    this.log("trace", section, `START ${label}`);
    return () => {
      const elapsedMs = Math.round((performance.now() - (this.startTimes.get(key) ?? performance.now())) * 100) / 100;
      this.startTimes.delete(key);
      this.log("debug", section, `END ${label}`, undefined, elapsedMs);
    };
  }

  /** Check whether debug mode is active, for callers that want to skip expensive data stringification. */
  get enabled(): boolean {
    return true;
  }
}

let instance: DebugLogger | null = null;

/** Get or initialize the process-scoped debug logger. Safe to call multiple times. */
export function getDebugLogger(logDir?: string, options: DebugLoggerOptions = {}): DebugLogger | null {
  if (instance) return instance;
  const enabled = process.env.SWARM_DEBUG === "1" || process.env.SWARM_DEBUG === "true" || process.env.SWARM_DEBUG === "verbose";
  if (!enabled || !logDir) return null;
  const rawLevel = process.env.SWARM_DEBUG_LEVEL;
  const level: DebugLogLevel = rawLevel === "trace" ? "trace" : rawLevel === "info" ? "info" : rawLevel === "warn" ? "warn" : rawLevel === "error" ? "error" : "debug";
  instance = new DebugLogger(logDir, level, options);
  return instance;
}

export function resetDebugLogger(): void {
  instance = null;
}

function defaultSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `session-${ts}`;
}

function sanitizeSessionId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || defaultSessionId();
}
