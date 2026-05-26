import React from "react";
import { Text } from "../ui.js";
import { resolveTuiColor, type TuiColorRef } from "../theme.js";

export type TonePillProps = {
  label: string;
  value?: string;
  tone?: TuiColorRef;
  selected?: boolean;
  prefixSpace?: boolean;
};

export function TonePill({ label, value, tone = "text.muted", selected = false, prefixSpace = false }: TonePillProps): React.ReactElement {
  const text = value ? `${label}:${value}` : label;
  return (
    <Text
      color={resolveTuiColor(selected ? "text.primary" : tone)}
      backgroundColor={selected ? resolveTuiColor("surface.selection") : undefined}
      inverse={selected && resolveTuiColor("surface.selection") === undefined}
    >
      {prefixSpace ? " " : ""}[{text}]
    </Text>
  );
}
