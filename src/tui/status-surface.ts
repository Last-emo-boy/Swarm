import type { PromptCacheRuntimeStatus } from "../runtime/prompt-cache-status.js";

export type ServiceSurfaceId = "cache" | "gateway" | "symphony" | "lsp" | "swarm";

export type ServiceNoticeSeverity = "hidden" | "info" | "warning" | "error" | "pending";

export type ServiceNotice = {
  service: ServiceSurfaceId;
  status: string;
  severity: ServiceNoticeSeverity;
  defaultVisible: boolean;
  summary: string;
};

export function serviceNotice(input: {
  service: ServiceSurfaceId;
  status?: string;
  summary?: string;
}): ServiceNotice {
  const status = input.status?.trim() || "unknown";
  const severity = serviceNoticeSeverity(status);
  return {
    service: input.service,
    status,
    severity,
    defaultVisible: severity === "warning" || severity === "error" || severity === "pending",
    summary: input.summary ?? `${input.service}: ${status}`
  };
}

export function serviceNoticeSeverity(status: string | undefined): ServiceNoticeSeverity {
  const normalized = (status ?? "").toLowerCase();
  if (["ok", "ready", "healthy", "success", "completed", "cache_hit", "hit", "warm", "stable", "local", "external"].includes(normalized)) {
    return "hidden";
  }
  if (["unknown", "stopped", "disabled", "cache_miss", "miss", "changed"].includes(normalized)) {
    return "info";
  }
  if (["pending", "queued", "waiting", "awaiting approval"].includes(normalized)) {
    return "pending";
  }
  if (["warning", "warn", "degraded", "partial", "reconnecting", "retrying", "unavailable", "blocked"].includes(normalized)) {
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
  return serviceNotice({
    service: "cache",
    status: status?.status,
    summary: status
      ? `cache ${status.status}${typeof status.hitRate === "number" ? ` hit=${Math.round(status.hitRate * 100)}%` : ""}`
      : "cache unknown"
  });
}

export function formatServiceStatusSection(input: {
  cache?: PromptCacheRuntimeStatus;
  gatewayStatus?: string;
  symphonyStatus?: string;
  lspStatus?: string;
}): string {
  const notices = [
    promptCacheNotice(input.cache),
    serviceNotice({ service: "gateway", status: input.gatewayStatus ?? "local" }),
    serviceNotice({ service: "symphony", status: input.symphonyStatus ?? "unknown" }),
    serviceNotice({ service: "lsp", status: input.lspStatus ?? "ready" })
  ];
  return [
    "Service Health",
    ...notices.map((notice) => `${notice.service}=${notice.status} severity=${notice.severity}`)
  ].join("\n");
}
