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

export function toneColor(tone: TuiTone): string {
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
  if (["completed", "complete", "success", "approved", "pass", "done", "ok"].includes(normalized)) {
    return "success";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    return "pending";
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
  if (["completed", "complete", "success", "approved", "pass", "done", "ok"].includes(normalized)) {
    return "[OK]";
  }
  if (["running", "started", "processing", "applied", "thinking", "executing"].includes(normalized)) {
    return "[RUN]";
  }
  if (["pending", "queued", "assigned", "waiting", "received", "awaiting approval"].includes(normalized)) {
    return "[ASK]";
  }
  if (["partial", "stopped", "blocked", "needs_revision", "warn", "warning"].includes(normalized)) {
    return "[WARN]";
  }
  if (["failed", "failure", "error", "denied", "reject", "cancelled"].includes(normalized)) {
    return "[ERR]";
  }
  return "[--]";
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

export function sandboxBadge(sandboxMode: string): string {
  if (sandboxMode === "read-only") return "RO";
  if (sandboxMode === "workspace-write") return "RW";
  return sandboxMode.toUpperCase();
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
