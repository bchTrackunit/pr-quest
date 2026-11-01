import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { Popover, usePopoverClose } from '../../../platform/ui/Popover.tsx';
import { MAX_PRESET_NAME_LENGTH, type Preset } from './boardViewStorage.ts';
import {
  activeFilterChips,
  AGENT_STATES,
  DEFAULT_FILTERS,
  DIFFICULTY_TIERS,
  toggleValue,
  viewsEqual,
  type BoardView,
  type QuestFilters,
  type QuestSort,
} from './questFilters.ts';

export const SEARCH_DEBOUNCE_MS = 200;

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** Arrow keys, Home and End move focus between the buttons of a toggle group. */
export function moveFocusWithArrows(event: KeyboardEvent<HTMLElement>): void {
  if (!ARROW_KEYS.has(event.key)) {
    return;
  }
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  );
  const index = buttons.findIndex((button) => button === document.activeElement);
  if (index < 0) {
    return;
  }
  const last = buttons.length - 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowRight'
          ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
}

/** The sort select's options; each value stands for one sort mode and direction. */
const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string; sort: Partial<QuestSort> }> = [
  { value: 'smart', label: 'Smart', sort: { mode: 'smart' } },
  { value: 'size-asc', label: 'Smallest first', sort: { mode: 'size', direction: 'asc' } },
  { value: 'size-desc', label: 'Largest first', sort: { mode: 'size', direction: 'desc' } },
];

const SORT_TITLES: Record<QuestSort['mode'], string> = {
  smart: 'Direct requests first, then needs attention, then the longest-waiting',
  size: 'Lines changed, then files changed',
};

function sortValue(sort: QuestSort): string {
  return sort.mode === 'smart' ? 'smart' : `size-${sort.direction}`;
}

/** How many of the filters inside the Filters panel are on. */
export function countPanelFilters(filters: QuestFilters): number {
  return (
    filters.tiers.length +
    filters.agentStates.length +
    (filters.hideDrafts ? 1 : 0) +
    (filters.hideApproved ? 1 : 0)
  );
}

interface SearchFieldProps {
  value: string;
  onCommit: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

/** Commits after a pause in typing, or right away on Enter; Escape clears. */
const SearchField = ({ value, onCommit, inputRef = undefined }: SearchFieldProps) => {
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);

  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === value) {
      return undefined;
    }
    const timer = setTimeout(() => onCommit(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit]);

  const commitNow = (next: string): void => {
    setDraft(next);
    onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitNow(draft);
    } else if (event.key === 'Escape' && draft) {
      event.preventDefault();
      event.stopPropagation();
      commitNow('');
    }
  };

  return (
    <div className="filters__search">
      <label className="visually-hidden" htmlFor={id}>
        Search quests
      </label>
      <input
        aria-describedby={hintId}
        autoComplete="off"
        className="field__input filters__search-input"
        id={id}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search title, author, branch or #123"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={draft}
      />
      <kbd aria-hidden="true" className="kbd filters__search-key">
        /
      </kbd>
      <span className="visually-hidden" id={hintId}>
        Press / to jump here and Escape to clear. Separate words to match all of them.
      </span>
    </div>
  );
};

interface ToggleGroupProps {
  label: string;
  children: ReactNode;
  className?: string;
}

const ToggleGroup = ({ label, children, className = 'segmented' }: ToggleGroupProps) => {
  const labelId = useId();
  return (
    <div className="filters__group">
      <span className="filters__label" id={labelId}>
        {label}
      </span>
      <div
        aria-labelledby={labelId}
        className={className}
        onKeyDown={moveFocusWithArrows}
        role="group"
      >
        {children}
      </div>
    </div>
  );
};

interface PresetListProps {
  view: BoardView;
  presets: Array<Preset>;
  onClickApplyPreset: (preset: Preset) => void;
  onSavePreset: (name: string) => string | undefined;
  onClickDeletePreset: (id: string) => void;
}

/** The presets dropdown: apply one, delete your own, or save the current view. */
const PresetMenu = ({
  view,
  presets,
  onClickApplyPreset,
  onSavePreset,
  onClickDeletePreset,
}: PresetListProps) => {
  const active = presets.find((preset) => viewsEqual(view, preset.view));
  return (
    <Popover
      align="end"
      buttonClassName="button filters__presets-button"
      buttonLabel={active ? `Presets: ${active.name}` : undefined}
      buttonContent={
        <>
          <span aria-hidden="true">★</span>
          {active ? <span className="filters__presets-name">{active.name}</span> : 'Presets'}
          <span aria-hidden="true" className="caret">
            ▾
          </span>
        </>
      }
      className="presets"
      label="Presets"
    >
      <PresetList
        onClickApplyPreset={onClickApplyPreset}
        onClickDeletePreset={onClickDeletePreset}
        onSavePreset={onSavePreset}
        presets={presets}
        view={view}
      />
    </Popover>
  );
};

const PresetList = ({
  view,
  presets,
  onClickApplyPreset,
  onSavePreset,
  onClickDeletePreset,
}: PresetListProps) => {
  const close = usePopoverClose();
  const nameId = useId();
  const [isSaving, setIsSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const saveButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isSaving) {
      nameInput.current?.focus();
    }
  }, [isSaving]);

  const closeForm = (): void => {
    setIsSaving(false);
    setName('');
    setError(undefined);
    saveButton.current?.focus();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const failure = onSavePreset(name);
    if (failure) {
      setError(failure);
      return;
    }
    closeForm();
  };

  return (
    <>
      <ul className="presets__list">
        {presets.map((preset) => (
          <li className="preset" key={preset.id}>
            <button
              aria-pressed={viewsEqual(view, preset.view)}
              className="chip chip--preset preset__apply"
              onClick={() => {
                onClickApplyPreset(preset);
                close();
              }}
              type="button"
            >
              {preset.builtIn ? <span aria-hidden="true">★ </span> : null}
              {preset.name}
            </button>
            {preset.builtIn ? null : (
              <button
                aria-label={`Delete preset ${preset.name}`}
                className="icon-button icon-button--small"
                onClick={() => {
                  onClickDeletePreset(preset.id);
                  saveButton.current?.focus();
                }}
                title={`Delete preset ${preset.name}`}
                type="button"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {isSaving ? (
        <form
          aria-label="Save preset"
          className="preset-form"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeForm();
            }
          }}
          onSubmit={onSubmit}
        >
          <label className="field__label" htmlFor={nameId}>
            Preset name
          </label>
          <input
            aria-invalid={error ? true : undefined}
            className="field__input preset-form__input"
            id={nameId}
            maxLength={MAX_PRESET_NAME_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            ref={nameInput}
            value={name}
          />
          <div className="button-row">
            <button className="button button--small button--primary" type="submit">
              Save preset
            </button>
            <button className="button button--small" onClick={closeForm} type="button">
              Cancel
            </button>
          </div>
          {error ? (
            <p className="form-error preset-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <button
        aria-expanded={isSaving}
        className="button button--small presets__save"
        onClick={() => (isSaving ? closeForm() : setIsSaving(true))}
        ref={saveButton}
        type="button"
      >
        <span aria-hidden="true">💾</span> Save current…
      </button>
    </>
  );
};

export interface QuestFilterBarProps {
  view: BoardView;
  onChangeView: (update: (view: BoardView) => BoardView) => void;
  presets: Array<Preset>;
  onClickApplyPreset: (preset: Preset) => void;
  onSavePreset: (name: string) => string | undefined;
  onClickDeletePreset: (id: string) => void;
  shownCount: number;
  totalCount: number;
  searchRef?: Ref<HTMLInputElement>;
}

export const QuestFilterBar = ({
  view,
  onChangeView,
  presets,
  onClickApplyPreset,
  onSavePreset,
  onClickDeletePreset,
  shownCount,
  totalCount,
  searchRef = undefined,
}: QuestFilterBarProps) => {
  const { filters, sort } = view;
  const sortId = useId();
  const panelId = useId();
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const chips = activeFilterChips(filters);
  const panelCount = countPanelFilters(filters);
  const setFilters = (update: Partial<QuestFilters>): void =>
    onChangeView((current) => ({ ...current, filters: { ...current.filters, ...update } }));
  const setSort = (update: Partial<QuestSort>): void =>
    onChangeView((current) => ({ ...current, sort: { ...current.sort, ...update } }));
  const commitSearch = useCallback(
    (search: string) =>
      onChangeView((current) => ({ ...current, filters: { ...current.filters, search } })),
    [onChangeView],
  );

  const closePanelOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && isPanelOpen && !event.defaultPrevented) {
      event.preventDefault();
      setIsPanelOpen(false);
      filtersButton.current?.focus();
    }
  };

  return (
    <section aria-label="Filter and sort quests" className="filters">
      <div className="filters__toolbar">
        <SearchField inputRef={searchRef} onCommit={commitSearch} value={filters.search} />
        <div className="filters__sort">
          <label className="filters__label" htmlFor={sortId}>
            Sort
          </label>
          <select
            className="field__input filters__select"
            id={sortId}
            onChange={(event) => {
              const option = SORT_OPTIONS.find((entry) => entry.value === event.target.value);
              if (option) {
                setSort(option.sort);
              }
            }}
            title={SORT_TITLES[sort.mode]}
            value={sortValue(sort)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <PresetMenu
          onClickApplyPreset={onClickApplyPreset}
          onClickDeletePreset={onClickDeletePreset}
          onSavePreset={onSavePreset}
          presets={presets}
          view={view}
        />
        <button
          aria-controls={isPanelOpen ? panelId : undefined}
          aria-expanded={isPanelOpen}
          aria-label={panelCount > 0 ? `Filters (${panelCount} active)` : undefined}
          className="button filters__toggle"
          onClick={() => setIsPanelOpen((open) => !open)}
          onKeyDown={closePanelOnEscape}
          ref={filtersButton}
          type="button"
        >
          Filters
          {panelCount > 0 ? <span className="count">{panelCount}</span> : null}
          <span aria-hidden="true" className="caret">
            {isPanelOpen ? '▴' : '▾'}
          </span>
        </button>
      </div>

      {isPanelOpen ? (
        <div
          aria-label="Filters"
          className="filters__panel"
          id={panelId}
          onKeyDown={closePanelOnEscape}
          role="group"
        >
          <ToggleGroup label="Difficulty">
            {DIFFICULTY_TIERS.map((tier) => (
              <button
                aria-pressed={filters.tiers.includes(tier)}
                className="segmented__option"
                key={tier}
                onClick={() =>
                  setFilters({ tiers: toggleValue(filters.tiers, tier, DIFFICULTY_TIERS) })
                }
                type="button"
              >
                {tier}
              </button>
            ))}
          </ToggleGroup>
          <ToggleGroup label="Agent">
            {AGENT_STATES.map((state) => (
              <button
                aria-pressed={filters.agentStates.includes(state.value)}
                className="segmented__option"
                key={state.value}
                onClick={() =>
                  setFilters({
                    agentStates: toggleValue(
                      filters.agentStates,
                      state.value,
                      AGENT_STATES.map((entry) => entry.value),
                    ),
                  })
                }
                type="button"
              >
                {state.label}
              </button>
            ))}
          </ToggleGroup>
          <ToggleGroup className="filters__switches" label="Hide">
            <button
              aria-pressed={filters.hideDrafts}
              className="button button--small switch"
              onClick={() => setFilters({ hideDrafts: !filters.hideDrafts })}
              type="button"
            >
              <span aria-hidden="true" className="switch__box">
                {filters.hideDrafts ? '■' : '□'}
              </span>
              Drafts
            </button>
            <button
              aria-pressed={filters.hideApproved}
              className="button button--small switch"
              onClick={() => setFilters({ hideApproved: !filters.hideApproved })}
              type="button"
            >
              <span aria-hidden="true" className="switch__box">
                {filters.hideApproved ? '■' : '□'}
              </span>
              Approved by others
            </button>
          </ToggleGroup>
        </div>
      ) : null}

      <div className="filters__summary">
        <p aria-live="polite" className="filters__count">
          Showing <strong>{shownCount}</strong> of <strong>{totalCount}</strong>{' '}
          {totalCount === 1 ? 'quest' : 'quests'}
        </p>
        {chips.length > 0 ? (
          <>
            <ul aria-label="Active filters" className="chip-list" onKeyDown={moveFocusWithArrows}>
              {chips.map((chip) => (
                <li key={chip.key}>
                  <button
                    aria-label={`Remove filter ${chip.label}`}
                    className="chip chip--small"
                    onClick={() => setFilters(chip.without)}
                    type="button"
                  >
                    {chip.label} <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="link-button filters__clear"
              onClick={() => setFilters(DEFAULT_FILTERS)}
              type="button"
            >
              Clear all
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
};
