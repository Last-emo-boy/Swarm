import type { PromptCacheRuntimeStatus } from "../../runtime/prompt-cache-status.js";
import type { TuiLspStatusSummary } from "../lsp-status.js";
import { promptCacheNotice, serviceNotice, type ServiceNotice } from "../status-surface.js";

export type RendererOperatorCockpitInput = {
  cache?: PromptCacheRuntimeStatus;
  gateway?: string;
  symphony?: string;
  swarm?: string;
  lsp?: TuiLspStatusSummary;
  route?: string;
  activeWorkItem?: string;
  recoveryAction?: string;
};

export type RendererOperatorCockpitRow = {
  id: string;
  label: string;
  status: string;
  severity: ServiceNotice["severity"];
  summary: string;
  nextAction?: string;
  visible: boolean;
};

export function buildRendererOperatorCockpit(input: RendererOperatorCockpitInput): RendererOperatorCockpitRow[] {
  const notices = [
    promptCacheNotice(input.cache),
    serviceNotice({ service: "gateway", status: input.gateway ?? "local" }),
    serviceNotice({ service: "symphony", status: input.symphony ?? "unknown" }),
    serviceNotice({ service: "swarm", status: input.swarm ?? "ready" }),
    serviceNotice({
      service: "lsp",
      status: input.lsp?.health ?? "unknown",
      summary: input.lsp
        ? `lsp ${input.lsp.health} providers=${input.lsp.readyProviders}/${input.lsp.providers}${input.lsp.fallbackReasons.length ? ` fallback=${input.lsp.fallbackReasons.join(",")}` : ""}`
        : "lsp unknown"
    })
  ];
  return notices.map((notice) => ({
    id: notice.service,
    label: notice.service.toUpperCase(),
    status: notice.status,
    severity: notice.severity,
    summary: [
      notice.summary,
      input.route && notice.service === "swarm" ? `route=${input.route}` : undefined,
      input.activeWorkItem && notice.service === "swarm" ? `work=${input.activeWorkItem}` : undefined,
      input.recoveryAction && notice.severity !== "hidden" ? `recovery=${input.recoveryAction}` : undefined
    ].filter(Boolean).join(" "),
    nextAction: notice.nextAction ?? (notice.severity === "error" || notice.severity === "warning" ? input.recoveryAction : undefined),
    visible: notice.defaultVisible || notice.service === "cache" || notice.service === "lsp"
  }));
}
