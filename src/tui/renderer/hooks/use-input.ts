import React from "react";

export type RendererKey = {
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  tab?: boolean;
  paste?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

export type RendererInputHandler = (input: string | undefined, key: RendererKey) => void;

export type RendererInputOptions = {
  isActive?: boolean;
};

export type RendererInputRegistry = {
  subscribe: (handler: RendererInputHandler, options?: RendererInputOptions) => () => void;
};

const RendererInputContext = React.createContext<RendererInputRegistry | undefined>(undefined);

export function RendererInputProvider({
  registry,
  children
}: {
  registry: RendererInputRegistry;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(RendererInputContext.Provider, { value: registry }, children);
}

export function useRendererInput(handler: RendererInputHandler, options: RendererInputOptions = {}): void {
  const registry = React.useContext(RendererInputContext);
  React.useLayoutEffect(() => {
    if (!registry || options.isActive === false) {
      return undefined;
    }
    return registry.subscribe(handler, options);
  }, [handler, options.isActive, registry]);
}

export function createInputRegistry(): RendererInputRegistry & {
  dispatch: (input: string | undefined, key?: RendererKey) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<{ handler: RendererInputHandler; options: RendererInputOptions }>();
  return {
    subscribe(handler, options = {}) {
      const entry = { handler, options };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    dispatch(input, key = {}) {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) {
          continue;
        }
        if (listener.options.isActive === false) {
          continue;
        }
        listener.handler(input, key);
      }
    },
    listenerCount() {
      return listeners.size;
    }
  };
}
