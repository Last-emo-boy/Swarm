export type TuiTone =
  | "brand"
  | "muted"
  | "success"
  | "running"
  | "pending"
  | "warning"
  | "danger"
  | "agent"
  | "neutral";

export type TuiStatus = "info" | "running" | "pending" | "success" | "warning" | "error";
export type TuiColor = "cyan" | "gray" | "green" | "yellow" | "red" | "magenta" | "white";
export type TranscriptEventKind = "message" | "logo" | "command" | "tool_use" | "tool_result" | "thinking" | "approval" | "progress";
export type ResultSectionKind = "summary" | "changed" | "checks" | "review" | "risks" | "recovery" | "artifacts" | "memory" | "contracts" | "checkpoint" | "cache" | "next";

export function toneColor(tone: TuiTone): TuiColor {
  switch (tone) {
    case "brand": return "cyan";
    case "success": return "green";
    case "running": return "cyan";
    case "pending": return "yellow";
    case "warning": return "yellow";
    case "danger": return "red";
    case "agent": return "magenta";
    case "muted": return "gray";
    case "neutral": return "white";
  }
}

export function statusTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["completed", "complete", "success", "approved", "pass", "passed", "done", "ok"].includes(normalized)) {
    return "success";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    return "pending";
  }
  if (["skipped", "skip", "unknown", "info", "idle", "disabled"].includes(normalized)) {
    return "muted";
  }
  if (["partial", "stopped", "blocked", "needs_revision", "warn", "warning"].includes(normalized)) {
    return "warning";
  }
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    return "danger";
  }
  return "muted";
}

export function statusBadge(status: string | undefined): string {
  const normalized = (status ?? "info").toLowerCase();
  if (["completed", "complete", "success", "approved", "pass", "passed", "done", "ok"].includes(normalized)) {
    return "[OK]";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "[RUN]";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    return "[ASK]";
  }
  if (["skipped", "skip"].includes(normalized)) {
    return "[SKIP]";
  }
  if (["partial", "stopped", "blocked", "needs_revision", "warn", "warning"].includes(normalized)) {
    return "[WARN]";
  }
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    return "[ERR]";
  }
  return "[--]";
}

export function statusMarker(status: string | undefined): string {
  const tone = statusTone(status);
  if (tone === "danger") return "✗";
  if (tone === "warning") return "!";
  if (tone === "success") return "✓";
  return "·";
}

export function routeBadge(route: string): string {
  if (route === "chat" || route === "ask") return "ASK";
  if (route === "coding_loop" || route === "work") return "WORK";
  if (route === "full_swarm" || route === "team") return "TEAM";
  return route.toUpperCase();
}

export function policyBadge(permissionMode: string): string {
  if (permissionMode === "ask") return "GUARDED";
  if (permissionMode === "auto-edit") return "AUTO-EDIT";
  if (permissionMode === "full-auto" || permissionMode === "auto") return "FULL-AUTO";
  if (permissionMode === "yolo") return "YOLO";
  return permissionMode.toUpperCase();
}

export function policyTone(permissionMode: string): TuiTone {
  if (permissionMode === "yolo") return "danger";
  if (permissionMode === "full-auto" || permissionMode === "auto") return "warning";
  if (permissionMode === "auto-edit") return "pending";
  return "muted";
}

export function sandboxBadge(sandboxMode: string): string {
  if (sandboxMode === "read-only") return "RO";
  if (sandboxMode === "workspace-write") return "RW";
  return sandboxMode.toUpperCase();
}

export function sandboxTone(sandboxMode: string): TuiTone {
  if (sandboxMode === "read-only") return "pending";
  if (sandboxMode === "workspace-write") return "success";
  return "warning";
}

export function transcriptEventToken(kind: TranscriptEventKind | undefined, status?: string): {
  prefix: string;
  label: string;
  tone: TuiTone;
} {
  switch (kind) {
    case "command":
      return { prefix: "❯ ", label: "cmd", tone: "brand" };
    case "tool_use":
      return { prefix: "⏵ tool ", label: "tool", tone: statusTone(status) === "muted" ? "running" : statusTone(status) };
    case "tool_result":
      return { prefix: `${statusMarker(status)} result `, label: "result", tone: statusTone(status) };
    case "thinking":
      return { prefix: "∴ think ", label: "think", tone: "muted" };
    case "approval":
      return { prefix: "? approval ", label: "approval", tone: "pending" };
    case "progress":
      return { prefix: "· progress ", label: "progress", tone: statusTone(status) === "muted" ? "running" : statusTone(status) };
    case "message":
    case "logo":
      return { prefix: "", label: "message", tone: "neutral" };
    default:
      return { prefix: "", label: "message", tone: "neutral" };
  }
}

export function resultSectionToken(section: ResultSectionKind): {
  label: string;
  tone: TuiTone;
} {
  switch (section) {
    case "summary": return { label: "SUMMARY", tone: "brand" };
    case "changed": return { label: "CHANGED", tone: "neutral" };
    case "checks": return { label: "CHECKS", tone: "success" };
    case "review": return { label: "REVIEW", tone: "pending" };
    case "risks": return { label: "RISKS", tone: "warning" };
    case "recovery": return { label: "RECOVERY", tone: "warning" };
    case "artifacts": return { label: "ARTIFACTS", tone: "neutral" };
    case "memory": return { label: "MEMORY", tone: "muted" };
    case "contracts": return { label: "CONTRACTS", tone: "neutral" };
    case "checkpoint": return { label: "CHECKPOINT", tone: "running" };
    case "cache": return { label: "CACHE", tone: "pending" };
    case "next": return { label: "NEXT", tone: "brand" };
  }
}

export function checkStatusTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "failed") return "danger";
  if (normalized === "skipped" || normalized === "unknown") return "warning";
  return statusTone(status);
}

export function cacheOutcomeTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["cache_hit", "hit", "warm", "stable", "ready", "ok"].includes(normalized)) return "success";
  if (["cache_miss", "miss", "changed", "unknown"].includes(normalized)) return "pending";
  if (["failed", "error", "unavailable", "disabled", "degraded"].includes(normalized)) return "warning";
  return normalized ? "neutral" : "muted";
}

export function serviceHealthTone(status: string | undefined): TuiTone {
  const normalized = (status ?? "").toLowerCase();
  if (["failed", "failure", "error", "denied", "cancelled", "blocked"].includes(normalized)) return "danger";
  if (["warning", "warn", "degraded", "partial", "reconnecting", "retrying", "unavailable"].includes(normalized)) return "warning";
  if (["pending", "queued", "waiting", "awaiting approval", "starting"].includes(normalized)) return "pending";
  if (["running", "processing"].includes(normalized)) return "running";
  if (["ok", "ready", "healthy", "success", "completed", "cache_hit", "hit", "warm", "stable", "local", "external"].includes(normalized)) return "success";
  return normalized ? "neutral" : "muted";
}

export function approvalRiskToken(input: { risk?: string; riskClass?: string }): {
  label: string;
  tone: TuiTone;
  badge: string;
} {
  const risk = input.risk?.toLowerCase() ?? "unknown";
  const riskClass = input.riskClass?.toLowerCase() ?? "r?";
  if (riskClass === "r4" || risk === "shell") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "danger", badge: "[HIGH]" };
  }
  if (riskClass === "r3" || risk === "install" || risk === "delegate") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "warning", badge: "[RISK]" };
  }
  if (riskClass === "r2" || risk === "write" || risk === "web") {
    return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "pending", badge: "[ASK]" };
  }
  return { label: `${riskClass.toUpperCase()}/${risk.toUpperCase()}`, tone: "muted", badge: "[LOW]" };
}

export function progressBar(completed: number, total: number, width = 12): string {
  if (!Number.isFinite(total) || total <= 0) {
    return `[${"-".repeat(width)}]`;
  }
  const safeCompleted = Math.max(0, Math.min(completed, total));
  const filled = Math.round((safeCompleted / total) * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

export function compactValue(value: string | undefined, maxLength: number): string {
  const input = value?.trim() ?? "";
  if (input.length <= maxLength) {
    return input;
  }
  if (maxLength <= 3) {
    return input.slice(0, maxLength);
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

export function sectionLabel(label: string): string {
  return label.toUpperCase();
}

export function compactId(value: string | undefined, maxLength = 10): string {
  return compactValue(value ?? "-", maxLength);
}

export function attentionRankForStatus(status: string | undefined): number {
  const tone = statusTone(status);
  if (tone === "danger") return 0;
  if (tone === "warning") return 1;
  if (tone === "pending") return 2;
  if (tone === "running") return 3;
  if (tone === "success") return 5;
  return 4;
}

export function compactKernelRow(input: {
  status?: string;
  kind?: string;
  id?: string;
  title: string;
  metadata?: Array<string | undefined>;
  maxTitleLength?: number;
  idLength?: number;
}): string {
  const label = [
    input.status ? statusBadge(input.status) : undefined,
    input.kind ? sectionLabel(input.kind) : undefined,
    input.id ? compactId(input.id, input.idLength ?? 10) : undefined
  ].filter((part): part is string => Boolean(part)).join(" ");
  const title = compactValue(input.title, input.maxTitleLength ?? 72);
  const metadata = (input.metadata ?? [])
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" | ");
  return [label, title, metadata ? `(${metadata})` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
