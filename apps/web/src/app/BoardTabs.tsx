import { useRef, type KeyboardEvent } from 'react';

import type { BoardTab } from '../features/game/index.ts';

export const BOARD_PANEL_ID = 'board-panel';

export interface BoardTabsProps {
  tab: BoardTab;
  /** How many of the player's PRs need their action; unset until the list has loaded. */
  needsMyAction?: number;
  onSelect: (tab: BoardTab) => void;
}

const TABS: ReadonlyArray<BoardTab> = ['reviews', 'mine'];

export const boardTabId = (tab: BoardTab): string => `board-tab-${tab}`;

/** Switches between the review requests board and the player's own PRs; one shows at a time. */
export const BoardTabs = ({ tab, needsMyAction = undefined, onSelect }: BoardTabsProps) => {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = TABS.indexOf(tab);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const target =
      event.key === 'Home'
        ? TABS[0]
        : event.key === 'End'
          ? TABS.at(-1)
          : step === undefined
            ? undefined
            : TABS[(index + step + TABS.length) % TABS.length];
    if (!target) {
      return;
    }
    event.preventDefault();
    onSelect(target);
    listRef.current?.querySelector<HTMLElement>(`#${boardTabId(target)}`)?.focus();
  };

  return (
    <div aria-label="Boards" className="segmented tabs" ref={listRef} role="tablist">
      {TABS.map((entry) => (
        <button
          aria-controls={BOARD_PANEL_ID}
          aria-selected={entry === tab}
          className="segmented__option"
          id={boardTabId(entry)}
          key={entry}
          onClick={() => onSelect(entry)}
          onKeyDown={onKeyDown}
          role="tab"
          tabIndex={entry === tab ? 0 : -1}
          type="button"
        >
          {entry === 'reviews' ? (
            'Review board'
          ) : (
            <>
              My PRs
              {needsMyAction === undefined ? null : (
                <>
                  {' '}
                  ({needsMyAction})<span className="visually-hidden">, need my action</span>
                </>
              )}
            </>
          )}
        </button>
      ))}
    </div>
  );
};
