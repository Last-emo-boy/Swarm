import React from "react";

export type RendererProgressProps = {
  value: number;
  width?: number;
  label?: string;
  showPercent?: boolean;
  completeChar?: string;
  incompleteChar?: string;
  color?: string;
  backgroundColor?: string;
};

export function Progress({
  value,
  width,
  label,
  showPercent = true,
  completeChar = "#",
  incompleteChar = "-"
}: RendererProgressProps): React.ReactElement {
  return React.createElement("swarm-progress", {
    value,
    width,
    label,
    showPercent,
    completeChar,
    incompleteChar
  });
}

export default Progress;
