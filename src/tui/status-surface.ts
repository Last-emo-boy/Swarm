import {
  buildPromptCacheRoi,
  formatPromptCacheRoiInline,
  promptCacheTrendFromResultCardCache,
  type PromptCacheRuntimeStatus
} from "../runtime/prompt-cache-status.js";
import type { BudgetGovernorReport } from "../runtime/budget-governor.js";
import { liveControlFromLegacyStatus, type LiveControlProjection } from "../runtime/live-control-status.js";
import { compactValue, type TuiTone } from "./theme.js";

export type ServiceSurfaceId = "cache" | "gateway" | "symphony" | "lsp" | "mcp" | "skills" | "swarm";

export type ServiceNoticeSeverity = "hidden" | "info" | "warning" | "error" | "pending";

export type ServiceNotice = {
  service: ServiceSurfaceId;
  status: string;
  severity: ServiceNoticeSeverity;
  defaultVisible: boolean;
  summary: string;
  nextAction?: string;
  liveControl?: LiveControlProjection;
};

export type BudgetPressureSurface = {
  status: BudgetGovernorReport["status"];
  pressure: string;
  deferred_tasks: number;
  sleeping_actors: number;
  accepted_tasks_preserved: number;
  summary: string;
};

export type ServiceClusterTone = Exclude<TuiTone, "agent" | "surface" | "tool" | "gateway" | "swarm" | "user"> | "neutral";

export type ServiceClusterItem = {
  service: ServiceSurfaceId;
  label: string;
  value: string;
  evidence: string;
  status: string;
  tone: ServiceClusterTone;
  severity: ServiceNoticeSeverity;
  summary: string;
  defaultVisible: boolean;
  nextAction?: string;
};

export function serviceNotice(input: {
  service: ServiceSurfaceId;
  status?: string;
  summary?: string;
  liveControl?: LiveControlProjection;
}): ServiceNotice {
  const liveControl = input.liveControl ?? liveControlFromLegacyStatus({
    status: input.status,
    source: input.service,
    summary: input.summary
  });
  const status = input.status?.trim() || liveControl.status || "unknown";
  const severity = input.liveControl ? liveControl.severity : serviceNoticeSeverity(status);
  return {
    service: input.service,
    status,
    severity,
    defaultVisible: severity === "warning" || severity === "error" || severity === "pending",
    summary: input.summary ?? `${input.service}: ${status}`,
    nextAction: liveControl.next_action,
    liveControl
  };
}

export function serviceNoticeSeverity(status: string | undefined): ServiceNoticeSeverity {
  const normalized = (status ?? "").toLowerCase();
  if (["ok", "ready", "healthy", "success", "completed", "cache_hit", "hit", "warm", "stable", "local", "external"].includes(normalized)) {
    return "hidden";
  }
  if (["unknown", "stopped", "disabled", "empty", "enabled_empty", "cache_miss", "miss", "changed"].includes(normalized)) {
    return "info";
  }
  if (["pending", "queued", "waiting", "awaiting approval", "waiting_approval"].includes(normalized)) {
    return "pending";
  }
  if (["warning", "warn", "critical", "exhausted", "degraded", "partial", "reconnecting", "retrying", "unavailable", "not-configured", "not_configured", "blocked"].includes(normalized)) {
    return "warning";
  }
  if (["failed", "failure", "error", "denied", "cancelled"].includes(normalized)) {
    return "error";
  }
  return "info";
}

export function defaultVisibleServiceNotices(notices: readonly ServiceNotice[]): ServiceNotice[] {
  return notices.filter((notice) => notice.defaultVisible);
}

export function promptCacheNotice(status: PromptCacheRuntimeStatus | undefined): ServiceNotice {
  const roi = status ? buildPromptCacheRoi(promptCacheTrendFromResultCardCache(status)) : undefined;
  return serviceNotice({
    service: "cache",
    status: status?.status,
    summary: status
      ? [
          `cache ${status.status}${typeof status.hitRate === "number" ? ` hit=${Math.round(status.hitRate * 100)}%` : ""}`,
          roi ? formatPromptCacheRoiInline(roi) : undefined
        ].filter(Boolean).join(" ")
      : "cache unknown"
  });
}

export function serviceClusterItem(input: {
  service: ServiceSurfaceId;
  status?: string;
  summary?: string;
  hitRate?: number;
  running?: number;
  retrying?: number;
  liveControl?: LiveControlProjection;
}): ServiceClusterItem {
  if (input.service === "cache") {
    return cacheClusterItem(input);
  }
  if (input.service === "symphony" && (typeof input.running === "number" || typeof input.retrying === "number")) {
    return symphonyClusterItem(input);
  }
  const notice = serviceNotice({
    service: input.service,
    status: input.status,
    summary: input.summary,
    liveControl: input.liveControl
  });
  return {
    service: notice.service,
    label: notice.service,
    value: serviceEvidenceValue(notice.service, notice.status),
    evidence: serviceEvidenceValue(notice.service, notice.status),
    status: notice.status,
    tone: serviceClusterTone(notice.severity, notice.status),
    severity: notice.severity,
    summary: notice.summary,
    defaultVisible: notice.defaultVisible,
    nextAction: notice.nextAction
  };
}

function serviceClusterItems(input: {
  cache?: PromptCacheRuntimeStatus;
  gatewayStatus?: string;
  gatewayLiveControl?: LiveControlProjection;
  mcpStatus?: string;
  mcpSummary?: string;
  skillStatus?: string;
  skillSummary?: string;
  symphonyStatus?: string;
  symphonyRunning?: number;
  symphonyRetrying?: number;
  symphonyLiveControl?: LiveControlProjection;
  lspStatus?: string;
  lspLiveControl?: LiveControlProjection;
  budget?: BudgetGovernorReport;
}): ServiceClusterItem[] {
  const items = [
    serviceClusterItem({
      service: "cache",
      status: input.cache?.status,
      hitRate: input.cache?.hitRate,
      summary: input.cache ? promptCacheNotice(input.cache).summary : "cache unknown"
    }),
    serviceClusterItem({ service: "gateway", status: input.gatewayStatus ?? "local", liveControl: input.gatewayLiveControl }),
    serviceClusterItem({ service: "mcp", status: input.mcpStatus ?? "disabled", summary: input.mcpSummary }),
    serviceClusterItem({ service: "skills", status: input.skillStatus ?? "empty", summary: input.skillSummary }),
    serviceClusterItem({
      service: "symphony",
      status: input.symphonyStatus ?? "unknown",
      running: input.symphonyRunning,
      retrying: input.symphonyRetrying,
      liveControl: input.symphonyLiveControl
    }),
    serviceClusterItem({ service: "lsp", status: input.lspStatus ?? "unknown", liveControl: input.lspLiveControl })
  ];
  if (input.budget) {
    items.push(budgetClusterItem(input.budget));
  }
  return items;
}

export function formatServiceStatusSection(input: {
  cache?: PromptCacheRuntimeStatus;
  gatewayStatus?: string;
  gatewayLiveControl?: LiveControlProjection;
  mcpStatus?: string;
  mcpSummary?: string;
  skillStatus?: string;
  skillSummary?: string;
  symphonyStatus?: string;
  symphonyRunning?: number;
  symphonyRetrying?: number;
  symphonyLiveControl?: LiveControlProjection;
  lspStatus?: string;
  lspLiveControl?: LiveControlProjection;
  budget?: BudgetGovernorReport;
}): string {
  const items = serviceClusterItems(input);
  return [
    "Service Health",
    ...items.map((item) =>
      `${item.service}=${item.status} value=${item.value} tone=${item.tone} severity=${item.severity}${item.nextAction ? ` next=${item.nextAction}` : ""}`
    )
  ].join("\n");
}

export function budgetPressureSurface(report: BudgetGovernorReport): BudgetPressureSurface {
  return {
    status: report.status,
    pressure: report.status,
    deferred_tasks: report.metrics.deferred_tasks,
    sleeping_actors: report.metrics.sleeping_actors,
    accepted_tasks_preserved: report.metrics.accepted_tasks_preserved,
    summary: `budget ${report.status} deferred=${report.metrics.deferred_tasks} sleeping=${report.metrics.sleeping_actors} preserved=${report.metrics.accepted_tasks_preserved}`
  };
}

function cacheClusterItem(input: {
  service: ServiceSurfaceId;
  status?: string;
  summary?: string;
  hitRate?: number;
}): ServiceClusterItem {
  const status = input.status?.trim() || "unknown";
  const severity = serviceNoticeSeverity(status);
  const value = typeof input.hitRate === "number"
    ? `${cacheStatusBadge(status)} ${Math.round(input.hitRate * 100)}%`
    : cacheStatusBadge(status);
  return {
    service: "cache",
    label: "cache",
    value: compactValue(value, 14),
    evidence: compactValue(value, 14),
    status,
    tone: cacheClusterTone(status),
    severity,
    summary: input.summary ?? `cache ${status}`,
    defaultVisible: severity === "warning" || severity === "error" || severity === "pending",
    nextAction: undefined
  };
}

function symphonyClusterItem(input: {
  service: ServiceSurfaceId;
  status?: string;
  running?: number;
  retrying?: number;
  liveControl?: LiveControlProjection;
}): ServiceClusterItem {
  const running = Math.max(0, input.running ?? 0);
  const retrying = Math.max(0, input.retrying ?? 0);
  const status = input.status?.trim() || (retrying > 0 ? "retrying" : running > 0 ? "running" : "idle");
  const notice = serviceNotice({ service: "symphony", status, liveControl: input.liveControl });
  const value = retrying > 0 ? `${running} run/${retrying} retry` : running > 0 ? `${running} run` : serviceEvidenceValue("symphony", status);
  return {
    service: "symphony",
    label: "symphony",
    value: compactValue(value, 18),
    evidence: compactValue(value, 18),
    status: notice.status,
    tone: retrying > 0 ? "warning" : running > 0 ? "running" : serviceClusterTone(notice.severity, notice.status),
    severity: notice.severity,
    summary: notice.summary,
    defaultVisible: notice.defaultVisible,
    nextAction: notice.nextAction
  };
}

function budgetClusterItem(report: BudgetGovernorReport): ServiceClusterItem {
  const surface = budgetPressureSurface(report);
  const severity = serviceNoticeSeverity(report.status === "normal" ? "ok" : report.status);
  return {
    service: "swarm",
    label: "budget",
    value: compactValue(`${report.status} d${surface.deferred_tasks}/s${surface.sleeping_actors}`, 18),
    evidence: compactValue(`${report.status} d${surface.deferred_tasks}/s${surface.sleeping_actors}`, 18),
    status: report.status,
    tone: serviceClusterTone(severity, report.status),
    severity,
    summary: surface.summary,
    defaultVisible: severity !== "hidden",
    nextAction: report.status === "normal" ? undefined : "Wait for retry-after, reduce concurrency, or resume deferred low-priority work later."
  };
}

function cacheStatusBadge(status: string): string {
  const normalized = status.toLowerCase();
  if (["cache_hit", "hit"].includes(normalized)) return "HIT";
  if (["warm", "stable", "ready", "ok"].includes(normalized)) return "WARM";
  if (["cache_miss", "miss", "changed", "cold"].includes(normalized)) return "MISS";
  if (normalized === "disabled") return "OFF";
  if (["failed", "error", "unavailable", "degraded"].includes(normalized)) return "DEGRADED";
  return compactValue(status.toUpperCase(), 14);
}

function cacheClusterTone(status: string): ServiceClusterTone {
  const normalized = status.toLowerCase();
  if (["error", "failed", "unavailable", "disabled", "degraded"].includes(normalized)) return "warning";
  if (["cache_hit", "hit", "warm", "stable", "ready", "ok"].includes(normalized)) return "success";
  if (["cache_miss", "miss", "changed", "unknown"].includes(normalized)) return "muted";
  return normalized ? "neutral" : "muted";
}

function serviceClusterTone(severity: ServiceNoticeSeverity, status: string): ServiceClusterTone {
  if (severity === "error") return "danger";
  if (severity === "warning") return "warning";
  if (severity === "pending") return "pending";
  const normalized = status.toLowerCase();
  if (["running", "starting", "processing"].includes(normalized)) return "running";
  if (["ready", "healthy", "ok", "local", "external", "connected", "active"].includes(normalized)) return "success";
  return normalized ? "muted" : "muted";
}

function serviceEvidenceValue(service: ServiceSurfaceId, status: string): string {
  const normalized = status.toLowerCase();
  if (service === "gateway") {
    if (normalized === "local") return "LOCAL";
    if (normalized === "external") return "REMOTE";
    if (normalized === "unavailable") return "NO ROUTE";
  }
  if (service === "lsp") {
    if (normalized === "disabled") return "OFF";
    if (normalized === "no-provider" || normalized === "no_provider" || normalized === "not-configured" || normalized === "not_configured") return "NO PROVIDER";
    if (normalized === "unknown") return "NO PROVIDER";
    if (normalized === "ready") return "READY";
    if (normalized === "fallback" || normalized === "typescript_semantic_fallback") return "TS FALLBACK";
    if (normalized === "partial") return "PARTIAL";
    if (normalized === "external") return "EXTERNAL";
    if (normalized === "unavailable") return "NO PROVIDER";
    if (normalized === "failed") return "FAILED";
  }
  if (service === "symphony" && normalized === "unknown") {
    return "NO DAEMON";
  }
  if (service === "mcp") {
    if (normalized === "connected") return "ON";
    if (normalized === "disabled") return "OFF";
    if (normalized === "enabled_empty") return "EMPTY";
    if (normalized === "pending") return "PENDING";
    if (normalized === "failed") return "FAILED";
    if (normalized === "degraded") return "DEGRADED";
    if (normalized === "configured") return "CONFIG";
  }
  if (service === "skills") {
    if (normalized === "active") return "ON";
    if (normalized === "disabled") return "OFF";
    if (normalized === "empty") return "EMPTY";
    if (normalized === "shadowed") return "SHADOWED";
    if (normalized === "untrusted") return "UNTRUSTED";
    if (normalized === "degraded") return "WARN";
  }
  return compactServiceValue(status).toUpperCase();
}

function compactServiceValue(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "typescript_semantic_fallback") return "ts-fallback";
  if (normalized === "unavailable") return "unavail";
  if (normalized === "reconnecting") return "reconnect";
  return compactValue(status || "--", 14);
}
