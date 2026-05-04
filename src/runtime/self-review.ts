import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SwarmPaths } from "../config/settings.js";
import type { SessionRow } from "../storage/session-store.js";

export type SelfReviewResult = {
  summary: string;
  findings: string[];
  recommendations: string[];
  inspected: {
    logs: number;
    sessions: number;
    artifacts: number;
  };
};

export async function createSelfReview(input: { paths: SwarmPaths; sessions: SessionRow[] }): Promise<SelfReviewResult> {
  const logs = await listFiles(input.paths.logsDir, ".log");
  const artifacts = await listFiles(input.paths.artifactsDir);
  const latestLogText = await readLatestLogs(logs.slice(0, 5));
  const findings: string[] = [];
  const recommendations: string[] = [];

  const errorCount = countMatches(latestLogText, /"level":"error"|ERROR|Tool action denied|failed/gi);
  const jsonRepairSignals = countMatches(latestLogText, /repair|invalid JSON|non-JSON|parse/gi);
  const interruptSignals = countMatches(latestLogText, /interrupt|live_message|control/gi);
  const workerSignals = countMatches(latestLogText, /worker_|spawn_worker|worker_notification/gi);

  if (errorCount > 0) {
    findings.push(`Recent logs contain ${errorCount} error/failure signals.`);
    recommendations.push("Group recurring failures by tool/action and add focused eval cases before adding new capabilities.");
  }
  if (jsonRepairSignals > 0) {
    findings.push(`Recent logs contain ${jsonRepairSignals} JSON/repair signals.`);
    recommendations.push("Keep schema repair, but add tests for malformed model output and log the repaired schema path.");
  }
  if (interruptSignals > 0) {
    findings.push(`Recent logs contain ${interruptSignals} live-control or interrupt signals.`);
    recommendations.push("Expose /why and pending-message status prominently so users can inspect live control decisions.");
  }
  if (workerSignals > 0) {
    findings.push(`Recent logs contain ${workerSignals} worker lifecycle signals.`);
    recommendations.push("Persist worker state and support continue/stop semantics before expanding distributed workers.");
  }
  if (artifacts.length > 20) {
    findings.push(`Artifact directory contains ${artifacts.length} files; long-output persistence is active.`);
    recommendations.push("Add artifact refs to worker notifications and blackboard entries so details remain traceable.");
  }
  if (input.sessions.some((session) => session.status === "failed")) {
    findings.push("Recent sessions include failed runs.");
    recommendations.push("Use failed session plans/traces as the seed data for the first self-iteration eval suite.");
  }
  if (findings.length === 0) {
    findings.push("No obvious failure pattern found in recent logs, sessions, or artifacts.");
    recommendations.push("Run more debug sessions or evals to generate enough evidence for self-improvement.");
  }

  return {
    summary: `Inspected ${logs.length} logs, ${input.sessions.length} sessions, and ${artifacts.length} artifacts.`,
    findings,
    recommendations,
    inspected: {
      logs: logs.length,
      sessions: input.sessions.length,
      artifacts: artifacts.length
    }
  };
}

async function listFiles(root: string, suffix?: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: Array<{ path: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (suffix && !entry.name.endsWith(suffix)) {
        continue;
      }
      const path = join(root, entry.name);
      const info = await stat(path);
      files.push({ path, mtime: info.mtimeMs });
    }
    return files.sort((a, b) => b.mtime - a.mtime).map((file) => file.path);
  } catch {
    return [];
  }
}

async function readLatestLogs(paths: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const path of paths) {
    try {
      chunks.push(await readFile(path, "utf8"));
    } catch {
      // Ignore unreadable debug logs.
    }
  }
  return chunks.join("\n");
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
