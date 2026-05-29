export type TuiStoreListener = () => void;
export type TuiStoreEquality<T> = (left: T, right: T) => boolean;

export type TuiStore<TState> = {
  getState: () => TState;
  setState: (updater: TState | ((previous: TState) => TState)) => void;
  subscribe: (listener: TuiStoreListener) => () => void;
  subscribeSelector: <TSelected>(
    selector: (state: TState) => TSelected,
    listener: (selected: TSelected, previous: TSelected) => void,
    options?: { equality?: TuiStoreEquality<TSelected>; fireImmediately?: boolean }
  ) => () => void;
};

export function createTuiStore<TState>(
  initialState: TState,
  onChange?: (next: TState, previous: TState) => void
): TuiStore<TState> {
  let state = initialState;
  const listeners = new Set<TuiStoreListener>();

  function emit(previous: TState): void {
    onChange?.(state, previous);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState() {
      return state;
    },
    setState(updater) {
      const previous = state;
      const next = typeof updater === "function"
        ? (updater as (previous: TState) => TState)(previous)
        : updater;
      if (Object.is(previous, next)) {
        return;
      }
      state = next;
      emit(previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeSelector(selector, listener, options = {}) {
      const equality = options.equality ?? Object.is;
      let selected = selector(state);
      if (options.fireImmediately) {
        listener(selected, selected);
      }
      return this.subscribe(() => {
        const next = selector(state);
        if (equality(selected, next)) {
          return;
        }
        const previous = selected;
        selected = next;
        listener(next, previous);
      });
    }
  };
}
