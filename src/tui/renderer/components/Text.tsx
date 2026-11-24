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
  focusable?: boolean;
  /**
   * Puts the terminal's cursor on this text's first cell after every frame. The renderer keeps the cursor hidden, but an
   * input method draws the text it is composing at the cursor, so a prompt marks the character its own cursor shows.
   */
  cursor?: boolean;
};

export function Text({ children, ...props }: RendererTextProps): React.ReactElement {
  return React.createElement("swarm-text", props, children);
}

export default Text;
