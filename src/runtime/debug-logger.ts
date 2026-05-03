import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DebugLogLevel = "trace" | "debug" | "info" | "warn" | "error";

type LogEntry = {
  ts: string;
  pid: number;
  level: DebugLogLevel;
  section: string;
  message: string;
  data?: unknown;
  elapsedMs?: number;
};

const LEVEL_RANK: Record<DebugLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
};

export class DebugLogger {
  private readonly path: string;
  private readonly minLevel: DebugLogLevel;
  private readonly pid: number;
  private readonly startTimes = new Map<string, number>();

  constructor(logDir: string, minLevel: DebugLogLevel = "debug") {
    this.minLevel = minLevel;
    this.pid = process.pid;
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = resolve(logDir, `debug-${this.pid}-${ts}.log`);
    this.log("debug", "debug-logger", `Logger started. pid=${this.pid} level=${minLevel} path=${this.path}`);
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
      level,
      section,
      message
    };
    if (data !== undefined) entry.data = data;
    if (elapsedMs !== undefined) entry.elapsedMs = elapsedMs;

    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // silently ignore write failures
    }
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
export function getDebugLogger(logDir?: string): DebugLogger | null {
  if (instance) return instance;
  const enabled = process.env.SWARM_DEBUG === "1" || process.env.SWARM_DEBUG === "true" || process.env.SWARM_DEBUG === "verbose";
  if (!enabled || !logDir) return null;
  const level = (process.env.SWARM_DEBUG_LEVEL as DebugLogLevel) ?? "debug";
  instance = new DebugLogger(logDir, level);
  return instance;
}
