import React from "react";
import { Text, type TextProps } from "../ui.js";
import { resolveTuiColor, type TuiColorRef } from "../theme.js";

export type ThemedTextProps = Omit<TextProps, "color" | "backgroundColor"> & {
  color?: TuiColorRef;
  backgroundColor?: TuiColorRef;
  muted?: boolean;
};

export function ThemedText({ color, backgroundColor, muted, ...props }: ThemedTextProps): React.ReactElement {
  return (
    <Text
      {...props}
      color={resolveTuiColor(color ?? (muted ? "text.muted" : undefined))}
      backgroundColor={resolveTuiColor(backgroundColor)}
    />
  );
}
