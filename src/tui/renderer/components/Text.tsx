import React from "react";

export type RendererTextProps = {
  children?: React.ReactNode;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  wrap?: "wrap" | "truncate";
};

export function Text({ children, ...props }: RendererTextProps): React.ReactElement {
  return React.createElement("swarm-text", props, children);
}

export default Text;
