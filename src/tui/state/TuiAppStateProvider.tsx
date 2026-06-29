import React from "react";
import { createInitialTuiAppState, type TuiAppState } from "./TuiAppState.js";
import { createTuiStore, type TuiStore } from "./store.js";

const TuiAppStateContext = React.createContext<TuiStore<TuiAppState> | undefined>(undefined);

export function createTuiAppStateStore(initialState: Partial<TuiAppState> = {}): TuiStore<TuiAppState> {
  return createTuiStore(createInitialTuiAppState(initialState));
}

export function TuiAppStateProvider({
  store,
  initialState,
  children
}: {
  store?: TuiStore<TuiAppState>;
  initialState?: Partial<TuiAppState>;
  children: React.ReactNode;
}): React.ReactElement {
  const storeRef = React.useRef<TuiStore<TuiAppState>>();
  storeRef.current ??= store ?? createTuiAppStateStore(initialState);
  return React.createElement(TuiAppStateContext.Provider, { value: storeRef.current }, children);
}

export function useTuiAppStateStore(): TuiStore<TuiAppState> {
  const store = React.useContext(TuiAppStateContext);
  if (!store) {
    throw new Error("useTuiAppStateStore must be used within TuiAppStateProvider.");
  }
  return store;
}

