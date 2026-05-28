import React from "react";
import { Text } from "../ui.js";
import { resolveTuiColor, type TuiColorRef } from "../theme.js";

export type TonePillProps = {
  label: string;
  value?: string;
  tone?: TuiColorRef;
  selected?: boolean;
  prefixSpace?: boolean;
  focusable?: boolean;
  onClick?: () => void;
};

export function TonePill({
  label,
  value,
  tone = "text.muted",
  selected = false,
  prefixSpace = false,
  focusable,
  onClick
}: TonePillProps): React.ReactElement {
  const text = value ? `${label}:${value}` : label;
  return (
    <Text
      color={resolveTuiColor(selected ? "text.primary" : tone)}
      backgroundColor={selected ? resolveTuiColor("surface.selection") : undefined}
      inverse={selected && resolveTuiColor("surface.selection") === undefined}
      focusable={focusable}
      onClick={onClick ? (() => onClick()) as never : undefined}
    >
      {prefixSpace ? " " : ""}[{text}]
    </Text>
  );
}
