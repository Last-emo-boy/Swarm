import type { SwarmSession } from "../protocol/types.js";

export type LiveControlStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "retrying"
  | "blocked"
  | "completed"
  | "failed"
  | "degraded";

export type LiveControlSeverity = "hidden" | "info" | "pending" | "warning" | "error";

export type LiveControlProjection = {
  status: LiveControlStatus;
  severity: LiveControlSeverity;
  summary: string;
  next_action?: string;
  legacy_status?: string;
  legacy_aliases?: string[];
};

export const LIVE_CONTROL_LEGACY_ALIASES: Record<LiveControlStatus, string[]> = {
  idle: ["idle", "stopped", "unknown"],
  running: ["starting", "created", "planning", "running", "reviewing", "aggregating", "active", "processing", "applied"],
  waiting_approval: ["pending", "queued", "waiting", "awaiting approval", "approval_pending"],
  retrying: ["retry", "retrying", "scheduled_retry"],
  blocked: ["blocked", "needs_revision"],
  completed: ["completed", "success", "done", "approved", "ok", "healthy", "ready", "local", "external", "enabled"],
  failed: ["failed", "failure", "error", "denied", "cancelled"],
  degraded: ["warning", "warn", "partial", "degraded", "reconnecting", "unavailable", "disabled", "stopping"]
};

export function liveControlProjection(input: {
  status: LiveControlStatus;
  source?: string;
  summary?: string;
  nextAction?: string;
  legacyStatus?: string;
}): LiveControlProjection {
  const aliases = legacyAliasesFor(input.status, input.legacyStatus);
  return stripUndefined({
    status: input.status,
    severity: liveControlSeverity(input.status),
    summary: input.summary ?? defaultLiveControlSummary(input.status, input.source),
    next_action: input.nextAction ?? defaultLiveControlNextAction(input.status),
    legacy_status: input.legacyStatus,
    legacy_aliases: aliases.length ? aliases : undefined
  });
}

export function liveControlFromLegacyStatus(input: {
  status?: string;
  source?: string;
  summary?: string;
  nextAction?: string;
}): LiveControlProjection {
  const legacyStatus = input.status?.trim();
  return liveControlProjection({
    status: normalizeLiveControlStatus(legacyStatus),
    source: input.source,
    summary: input.summary,
    nextAction: input.nextAction,
    legacyStatus
  });
}

export function liveControlFromSessionStatus(input: {
  status: SwarmSession["status"] | string;
  source?: string;
  pendingApprovals?: number;
  retrying?: boolean;
  blocked?: number;
  failed?: number;
  degraded?: boolean;
  summary?: string;
  nextAction?: string;
}): LiveControlProjection {
  const status = input.pendingApprovals && input.pendingApprovals > 0
    ? "waiting_approval"
    : input.retrying
      ? "retrying"
      : input.blocked && input.blocked > 0
        ? "blocked"
        : input.degraded
          ? "degraded"
          : input.failed && input.failed > 0
            ? "failed"
            : normalizeLiveControlStatus(input.status);
  return liveControlProjection({
    status,
    source: input.source,
    summary: input.summary,
    nextAction: input.nextAction,
    legacyStatus: input.status
  });
}

export function liveControlFromCounts(input: {
  source?: string;
  total?: number;
  running?: number;
  completed?: number;
  failed?: number;
  pendingApprovals?: number;
  retrying?: number;
  blocked?: number;
  degraded?: boolean;
  summary?: string;
  nextAction?: string;
}): LiveControlProjection {
  const status: LiveControlStatus = input.pendingApprovals && input.pendingApprovals > 0
    ? "waiting_approval"
    : input.retrying && input.retrying > 0
      ? "retrying"
      : input.blocked && input.blocked > 0
        ? "blocked"
        : input.degraded
          ? "degraded"
          : input.failed && input.failed > 0
            ? "failed"
            : input.running && input.running > 0
              ? "running"
              : input.total && input.total > 0 && input.completed && input.completed > 0
                ? "completed"
                : "idle";
  return liveControlProjection({
    status,
    source: input.source,
    summary: input.summary,
    nextAction: input.nextAction
  });
}

export function liveControlSeverity(status: LiveControlStatus): LiveControlSeverity {
  switch (status) {
    case "idle":
    case "completed":
      return "hidden";
    case "running":
      return "info";
    case "waiting_approval":
      return "pending";
    case "retrying":
    case "blocked":
    case "degraded":
      return "warning";
    case "failed":
      return "error";
  }
}

export function normalizeLiveControlStatus(value: string | undefined): LiveControlStatus {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) {
    return "idle";
  }
  for (const [status, aliases] of Object.entries(LIVE_CONTROL_LEGACY_ALIASES) as Array<[LiveControlStatus, string[]]>) {
    if (status === normalized || aliases.includes(normalized) || aliases.includes(normalized.replace(/_/g, " "))) {
      return status;
    }
  }
  return "degraded";
}

function defaultLiveControlSummary(status: LiveControlStatus, source = "live-control"): string {
  return `${source}: ${status.replace(/_/g, " ")}`;
}

function defaultLiveControlNextAction(status: LiveControlStatus): string | undefined {
  switch (status) {
    case "waiting_approval":
      return "Review pending approvals, then approve or deny.";
    case "retrying":
      return "Wait for the retry window, or trigger a retry after fixing the cause.";
    case "blocked":
      return "Inspect the blocker, resolve the dependency or approval, then resume.";
    case "degraded":
      return "Open status details, inspect recent errors, and restart or reconfigure the service.";
    case "failed":
      return "Open the latest diagnosis or logs, fix the error, then retry.";
    default:
      return undefined;
  }
}

function legacyAliasesFor(status: LiveControlStatus, legacyStatus: string | undefined): string[] {
  const aliases = LIVE_CONTROL_LEGACY_ALIASES[status];
  if (!legacyStatus || legacyStatus === status) {
    return aliases;
  }
  return aliases.includes(legacyStatus) ? aliases : [legacyStatus, ...aliases];
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}
