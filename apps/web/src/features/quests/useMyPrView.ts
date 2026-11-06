import { useCallback, useEffect, useState } from 'react';

import type { StorageLike } from './boardViewStorage.ts';
import { loadMyPrView, saveMyPrView, type MyPrView } from './myPrFilters.ts';
import { browserStorage } from './useBoardView.ts';

export interface MyPrViewState {
  view: MyPrView;
  setView: (update: (view: MyPrView) => MyPrView) => void;
}

/** The My PRs tab's search, sort and filters, remembered apart from the review board's. */
export function useMyPrView(storage: StorageLike | undefined = browserStorage()): MyPrViewState {
  const [view, setViewState] = useState(() => loadMyPrView(storage));

  useEffect(() => saveMyPrView(storage, view), [storage, view]);

  const setView = useCallback((update: (current: MyPrView) => MyPrView) => {
    setViewState(update);
  }, []);

  return { view, setView };
}
