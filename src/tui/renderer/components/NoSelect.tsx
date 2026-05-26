import React from "react";

export type RendererNoSelectProps = {
  children?: React.ReactNode;
};

export function NoSelect({ children }: RendererNoSelectProps): React.ReactElement {
  return React.createElement("swarm-no-select", { noSelect: true }, children);
}

export default NoSelect;
