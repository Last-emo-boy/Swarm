import React from "react";

export type RendererBoxProps = {
  children?: React.ReactNode;
  flexDirection?: "row" | "column";
  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  minHeight?: number | string;
  maxHeight?: number | string;
  flexGrow?: number;
  flexShrink?: number;
  paddingX?: number;
  paddingY?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  position?: "absolute" | "relative";
  justifyContent?: "flex-start" | "center" | "flex-end";
  alignItems?: "flex-start" | "center" | "flex-end";
  borderStyle?: "single" | "round";
  borderColor?: string;
  borderTop?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  borderRight?: boolean;
  focusable?: boolean;
  focused?: boolean;
  hidden?: boolean;
};

export function Box({ children, ...props }: RendererBoxProps): React.ReactElement {
  return React.createElement("swarm-box", props, children);
}

export default Box;
