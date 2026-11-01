import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addPreset,
  BUILT_IN_PRESETS,
  loadPresets,
  loadView,
  removePreset,
  savePresets,
  saveView,
  type Preset,
  type StorageLike,
} from './boardViewStorage.ts';
import type { BoardView } from './questFilters.ts';

export interface BoardViewState {
  view: BoardView;
  setView: (update: (view: BoardView) => BoardView) => void;
  /** Built-in presets first, then the player's. */
  presets: Array<Preset>;
  applyPreset: (preset: Preset) => void;
  /** Saves the current view under `name`; returns an error message when it can't. */
  savePreset: (name: string) => string | undefined;
  deletePreset: (id: string) => void;
}

/** `localStorage`, or `undefined` where the browser blocks it. */
function browserStorage(): StorageLike | undefined {
  try {
    // oxlint-disable-next-line no-restricted-properties -- @trackunit/react-components isn't a dependency here; this is the app's one storage access point.
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The board's filters, sort and presets, remembered in `localStorage`. */
export function useBoardView(storage: StorageLike | undefined = browserStorage()): BoardViewState {
  const [view, setViewState] = useState(() => loadView(storage));
  const [userPresets, setUserPresets] = useState(() => loadPresets(storage));

  useEffect(() => saveView(storage, view), [storage, view]);
  useEffect(() => savePresets(storage, userPresets), [storage, userPresets]);

  const setView = useCallback((update: (current: BoardView) => BoardView) => {
    setViewState(update);
  }, []);

  const savePreset = useCallback(
    (name: string): string | undefined => {
      const result = addPreset(userPresets, name, view);
      if ('error' in result) {
        return result.error;
      }
      setUserPresets(result.presets);
      return undefined;
    },
    [userPresets, view],
  );

  return {
    view,
    setView,
    presets: useMemo(() => [...BUILT_IN_PRESETS, ...userPresets], [userPresets]),
    applyPreset: useCallback((preset: Preset) => setViewState(preset.view), []),
    savePreset,
    deletePreset: useCallback(
      (id: string) => setUserPresets((current) => removePreset(current, id)),
      [],
    ),
  };
}
