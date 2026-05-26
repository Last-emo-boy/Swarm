import React from "react";
import { Text } from "../ui.js";
import {
  resolveTuiColor,
  statusIconStatus,
  type TuiColorRef,
  type TuiPrimitiveStatus
} from "../theme.js";

export type StatusIconProps = {
  status: TuiPrimitiveStatus | string | undefined;
  withSpace?: boolean;
  label?: "icon" | "badge";
};

const STATUS_CONFIG: Record<TuiPrimitiveStatus, { icon: string; badge: string; color: TuiColorRef; dim?: boolean }> = {
  success: { icon: "✓", badge: "[OK]", color: "status.success" },
  error: { icon: "✗", badge: "[ERR]", color: "status.danger" },
  warning: { icon: "!", badge: "[WARN]", color: "status.warning" },
  info: { icon: "·", badge: "[--]", color: "text.muted", dim: true },
  pending: { icon: "?", badge: "[ASK]", color: "status.pending" },
  loading: { icon: "…", badge: "[RUN]", color: "status.running" }
};

export function StatusIcon({ status, withSpace = false, label = "icon" }: StatusIconProps): React.ReactElement {
  const normalized = primitiveStatus(status);
  const config = STATUS_CONFIG[normalized];
  return (
    <Text color={resolveTuiColor(config.color)} dim={config.dim}>
      {label === "badge" ? config.badge : config.icon}{withSpace ? " " : ""}
    </Text>
  );
}

export function statusIconText(status: TuiPrimitiveStatus | string | undefined, label: "icon" | "badge" = "icon"): string {
  return STATUS_CONFIG[primitiveStatus(status)][label];
}

export function primitiveStatus(status: TuiPrimitiveStatus | string | undefined): TuiPrimitiveStatus {
  if (status === "success" || status === "error" || status === "warning" || status === "info" || status === "pending" || status === "loading") {
    return status;
  }
  return statusIconStatus(status);
}
