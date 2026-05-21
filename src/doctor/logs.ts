import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getSwarmPaths } from "../config/settings.js";

export type SwarmLogRecord = {
  name: string;
  path: string;
  size: number;
  updatedAt: string;
};

export function listSwarmLogs(limit = 20): SwarmLogRecord[] {
  const logsDir = getSwarmPaths().logsDir;
  if (!existsSync(logsDir)) {
    return [];
  }
  return readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => {
      const path = resolve(logsDir, entry.name);
      const stat = statSync(path);
      return {
        name: entry.name,
        path,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
    .map(({ mtimeMs: _mtimeMs, ...log }) => log)
    .slice(0, Math.max(1, limit));
}

export function resolveSwarmLog(query?: string): SwarmLogRecord | undefined {
  const logs = listSwarmLogs(200);
  if (logs.length === 0) {
    return undefined;
  }
  const trimmed = query?.trim();
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return logs[0];
  }
  const normalized = trimmed.toLowerCase();
  return logs.find((log) => log.path.toLowerCase() === normalized)
    ?? logs.find((log) => log.name.toLowerCase() === normalized)
    ?? logs.find((log) => basename(log.path).toLowerCase() === normalized)
    ?? logs.find((log) => log.name.toLowerCase().includes(normalized));
}

export function readSwarmLogTail(path: string, lines = 120): string {
  const content = readFileSync(path, "utf8");
  const normalized = content.replace(/\r?\n$/, "");
  return normalized.split(/\r?\n/).slice(-Math.max(1, lines)).join("\n").trimEnd();
}

export function formatSwarmLogList(logs: SwarmLogRecord[]): string {
  if (logs.length === 0) {
    return "No Swarm debug logs found. Start Swarm with --debug or --debug-trace to write session logs.";
  }
  return [
    "Swarm Logs",
    ...logs.map((log) => `${log.updatedAt} ${formatBytes(log.size).padStart(8)} ${log.name}`),
    "",
    "Use `swarm logs latest --tail 120` or `swarm logs <name> --tail 120` to inspect one file."
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
