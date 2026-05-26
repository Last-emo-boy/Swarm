import React from "react";
import { Box, type BoxProps } from "../ui.js";
import { resolveTuiColor, type TuiColorRef } from "../theme.js";

export type ThemedBoxProps = Omit<BoxProps, "borderColor"> & {
  borderColor?: TuiColorRef;
};

export function ThemedBox({ borderColor, ...props }: ThemedBoxProps): React.ReactElement {
  return (
    <Box
      {...props}
      borderColor={resolveTuiColor(borderColor)}
    />
  );
}
