import { useCallback, useSyncExternalStore } from 'react';

export interface Store<TState> {
  getState: () => TState;
  setState: (update: (state: TState) => TState) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<TState>(initialState: TState): Store<TState> {
  let state = initialState;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (update) => {
      const next = update(state);
      if (next === state) {
        return;
      }
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribes to a slice of the store. The selector must return a stable reference for unchanged state. */
export function useStoreState<TState, TSlice>(
  store: Store<TState>,
  selector: (state: TState) => TSlice,
): TSlice {
  const getSnapshot = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
