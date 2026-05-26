import React from "react";

export type RendererStdout = {
  stdout?: NodeJS.WriteStream;
  columns: number;
  rows: number;
};

const RendererStdoutContext = React.createContext<RendererStdout>({
  columns: 80,
  rows: 24
});

export function RendererStdoutProvider({
  value,
  children
}: {
  value: RendererStdout;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(RendererStdoutContext.Provider, { value }, children);
}

export function useRendererStdout(): RendererStdout {
  return React.useContext(RendererStdoutContext);
}
