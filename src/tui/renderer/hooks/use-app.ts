import React from "react";

export type RendererAppContextValue = {
  exit: (error?: Error) => void;
};

const RendererAppContext = React.createContext<RendererAppContextValue>({
  exit(error?: Error) {
    if (error) {
      throw error;
    }
  }
});

export function RendererAppProvider({
  value,
  children
}: {
  value: RendererAppContextValue;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(RendererAppContext.Provider, { value }, children);
}

export function useRendererApp(): RendererAppContextValue {
  return React.useContext(RendererAppContext);
}
