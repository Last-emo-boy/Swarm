import React from "react";
import { Text } from "../ui.js";
import { resolveTuiColor, roleTone, type TuiRole } from "../theme.js";

export type RoleMarkerProps = {
  role: TuiRole;
  withSpace?: boolean;
  label?: boolean;
};

const ROLE_CONFIG: Record<TuiRole, { marker: string; label: string }> = {
  user: { marker: "❯", label: "user" },
  assistant: { marker: "·", label: "assistant" },
  tool: { marker: "⏵", label: "tool" },
  gateway: { marker: "◇", label: "gateway" },
  swarm: { marker: "◆", label: "swarm" },
  system: { marker: "·", label: "system" }
};

export function RoleMarker({ role, withSpace = false, label = false }: RoleMarkerProps): React.ReactElement {
  const config = ROLE_CONFIG[role];
  return (
    <Text color={resolveTuiColor(roleTone(role))}>
      {label ? config.label : config.marker}{withSpace ? " " : ""}
    </Text>
  );
}

