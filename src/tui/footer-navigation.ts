import { compactValue } from "./theme.js";
import { serviceClusterItem, type ServiceClusterItem } from "./status-surface.js";

export type FooterPillId = "tasks" | "approvals" | "cache" | "gateway" | "mcp" | "skills" | "symphony" | "lsp";

export type FooterPillTone = "neutral" | "running" | "pending" | "success" | "warning" | "danger" | "muted";

export type FooterPill = {
  id: FooterPillId;
  label: string;
  value: string;
  tone: FooterPillTone;
  detailHint?: string;
};

export type FooterNavigationState = {
  selectedId?: FooterPillId;
  openId?: FooterPillId;
};

export type FooterNavigationAction =
  | { type: "next" }
  | { type: "previous" }
  | { type: "select"; id: FooterPillId }
  | { type: "open"; id?: FooterPillId }
  | { type: "close" }
  | { type: "clear" };

export function createFooterNavigationState(): FooterNavigationState {
  return {};
}

export function footerNavigationReducer(
  state: FooterNavigationState,
  action: FooterNavigationAction,
  items: readonly FooterPill[]
): FooterNavigationState {
  const ids = items.map((item) => item.id);
  if (ids.length === 0) {
    return {};
  }
  const selected = ids.includes(state.selectedId as FooterPillId) ? state.selectedId : undefined;
  switch (action.type) {
    case "next":
      return { selectedId: selected ? stepFooterSelection(ids, selected, 1) : ids[0], openId: state.openId };
    case "previous":
      return { selectedId: selected ? stepFooterSelection(ids, selected, -1) : ids[ids.length - 1], openId: state.openId };
    case "select":
      return ids.includes(action.id) ? { selectedId: action.id, openId: state.openId } : state;
    case "open": {
      const openId = action.id ?? selected;
      if (!action.id && !selected) {
        return state;
      }
      return openId && ids.includes(openId) ? { selectedId: openId, openId } : state;
    }
    case "close": {
      return selected ? { selectedId: selected } : {};
    }
    case "clear":
      return {};
  }
}

export function selectedFooterPill(
  state: FooterNavigationState,
  items: readonly FooterPill[]
): FooterPill | undefined {
  const selectedId = state.selectedId;
  if (!selectedId) {
    return undefined;
  }
  return items.find((item) => item.id === selectedId);
}

export function buildFooterPills(input: {
  taskCompleted: number;
  taskTotal: number;
  pendingApprovals: number;
  cacheStatus?: string;
  cacheHitRate?: number;
  gatewayStatus?: string;
  mcpStatus?: string;
  skillStatus?: string;
  symphonyRunning: number;
  symphonyRetrying: number;
  lspStatus?: string;
}): FooterPill[] {
  const cache = serviceClusterItem({ service: "cache", status: input.cacheStatus, hitRate: input.cacheHitRate });
  const gateway = serviceClusterItem({ service: "gateway", status: input.gatewayStatus ?? "local" });
  const mcp = serviceClusterItem({ service: "mcp", status: input.mcpStatus ?? "disabled" });
  const skills = serviceClusterItem({ service: "skills", status: input.skillStatus ?? "empty" });
  const symphony = serviceClusterItem({
    service: "symphony",
    running: input.symphonyRunning,
    retrying: input.symphonyRetrying,
    status: input.symphonyRetrying > 0 ? "retrying" : input.symphonyRunning > 0 ? "running" : "unknown"
  });
  const lsp = serviceClusterItem({ service: "lsp", status: input.lspStatus ?? "unknown" });
  return [
    {
      id: "tasks",
      label: "tasks",
      value: `${Math.max(0, input.taskCompleted)}/${Math.max(0, input.taskTotal)}`,
      tone: input.taskTotal > 0 && input.taskCompleted < input.taskTotal ? "running" : "muted",
      detailHint: "Task state"
    },
    {
      id: "approvals",
      label: "approvals",
      value: String(Math.max(0, input.pendingApprovals)),
      tone: input.pendingApprovals > 0 ? "pending" : "muted",
      detailHint: "Approval queue"
    },
    {
      id: "cache",
      label: "cache",
      value: cache.value,
      tone: footerToneFromServiceCluster(cache),
      detailHint: "Prompt cache"
    },
    {
      id: "gateway",
      label: "gateway",
      value: gateway.value,
      tone: footerToneFromServiceCluster(gateway),
      detailHint: "Gateway surface"
    },
    {
      id: "mcp",
      label: "mcp",
      value: mcp.value,
      tone: footerToneFromServiceCluster(mcp),
      detailHint: "MCP servers"
    },
    {
      id: "skills",
      label: "skills",
      value: skills.value,
      tone: footerToneFromServiceCluster(skills),
      detailHint: "Agent skills"
    },
    {
      id: "symphony",
      label: "symphony",
      value: symphony.value,
      tone: footerToneFromServiceCluster(symphony),
      detailHint: "Symphony scheduler"
    },
    {
      id: "lsp",
      label: "lsp",
      value: lsp.value,
      tone: footerToneFromServiceCluster(lsp),
      detailHint: "Language server"
    }
  ];
}

export function footerRowBudget(input: {
  footerItems: readonly FooterPill[];
  panelOpen?: boolean;
  terminalRows: number;
}): { footerRows: number; panelRows: number } {
  const footerRows = input.footerItems.length > 0 ? 1 : 0;
  const panelRows = input.panelOpen
    ? Math.max(3, Math.min(8, Math.floor(input.terminalRows * 0.25)))
    : 0;
  return { footerRows, panelRows };
}

function stepFooterSelection(ids: FooterPillId[], selected: FooterPillId | undefined, delta: number): FooterPillId {
  const currentIndex = Math.max(0, selected ? ids.indexOf(selected) : 0);
  const nextIndex = (currentIndex + delta + ids.length) % ids.length;
  return ids[nextIndex] ?? ids[0]!;
}

function footerToneFromServiceCluster(item: ServiceClusterItem): FooterPillTone {
  if (item.tone === "danger") return "danger";
  if (item.tone === "warning") return "warning";
  if (item.tone === "pending") return "pending";
  if (item.tone === "running") return "running";
  if (item.tone === "success") return "success";
  if (item.tone === "muted") return "muted";
  return "neutral";
}
