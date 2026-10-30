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
    <div className="field filters__search">
      <label className="field__label" htmlFor={id}>
        Search quests <kbd className="kbd">/</kbd>
      </label>
      <input
        aria-describedby={hintId}
        autoComplete="off"
        className="field__input"
        id={id}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Title, author, branch, #123 or repo#123"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={draft}
      />
      <span className="visually-hidden" id={hintId}>
        Press Escape to clear. Separate words to match all of them.
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

interface PresetBarProps {
  view: BoardView;
  presets: Array<Preset>;
  onClickApplyPreset: (preset: Preset) => void;
  onSavePreset: (name: string) => string | undefined;
  onClickDeletePreset: (id: string) => void;
}

const PresetBar = ({
  view,
  presets,
  onClickApplyPreset,
  onSavePreset,
  onClickDeletePreset,
}: PresetBarProps) => {
  const labelId = useId();
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

  const close = (): void => {
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
    close();
  };

  return (
    <div className="filters__presets">
      <div className="filters__group">
        <span className="filters__label" id={labelId}>
          Presets
        </span>
        <ul aria-labelledby={labelId} className="chip-list" onKeyDown={moveFocusWithArrows}>
          {presets.map((preset) => (
            <li className="preset" key={preset.id}>
              <button
                aria-pressed={viewsEqual(view, preset.view)}
                className="chip chip--preset"
                onClick={() => onClickApplyPreset(preset)}
                type="button"
              >
                {preset.builtIn ? <span aria-hidden="true">★ </span> : null}
                {preset.name}
              </button>
              {preset.builtIn ? null : (
                <button
                  aria-label={`Delete preset ${preset.name}`}
                  className="icon-button icon-button--small"
                  onClick={() => onClickDeletePreset(preset.id)}
                  title={`Delete preset ${preset.name}`}
                  type="button"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
          <li>
            <button
              aria-expanded={isSaving}
              className="button button--small"
              onClick={() => (isSaving ? close() : setIsSaving(true))}
              ref={saveButton}
              type="button"
            >
              <span aria-hidden="true">💾</span> Save current…
            </button>
          </li>
        </ul>
      </div>
      {isSaving ? (
        <form
          aria-label="Save preset"
          className="preset-form"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
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
          <button className="button button--small button--primary" type="submit">
            Save preset
          </button>
          <button className="button button--small" onClick={close} type="button">
            Cancel
          </button>
          {error ? (
            <p className="form-error preset-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
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
  const chips = activeFilterChips(filters);
  const setFilters = (update: Partial<QuestFilters>): void =>
    onChangeView((current) => ({ ...current, filters: { ...current.filters, ...update } }));
  const setSort = (update: Partial<QuestSort>): void =>
    onChangeView((current) => ({ ...current, sort: { ...current.sort, ...update } }));
  const commitSearch = useCallback(
    (search: string) =>
      onChangeView((current) => ({ ...current, filters: { ...current.filters, search } })),
    [onChangeView],
  );

  return (
    <section aria-label="Filter and sort quests" className="filters">
      <div className="filters__row">
        <SearchField inputRef={searchRef} onCommit={commitSearch} value={filters.search} />
        <ToggleGroup label="Sort">
          <button
            aria-pressed={sort.mode === 'smart'}
            className="segmented__option"
            onClick={() => setSort({ mode: 'smart' })}
            title="Direct requests first, then needs attention, then the longest-waiting"
            type="button"
          >
            Smart
          </button>
          <button
            aria-pressed={sort.mode === 'size'}
            className="segmented__option"
            onClick={() => setSort({ mode: 'size' })}
            title="Lines changed, then files changed"
            type="button"
          >
            Size
          </button>
        </ToggleGroup>
        {sort.mode === 'size' ? (
          <ToggleGroup label="Size order">
            <button
              aria-pressed={sort.direction === 'asc'}
              className="segmented__option"
              onClick={() => setSort({ direction: 'asc' })}
              type="button"
            >
              <span aria-hidden="true">↑ </span>Smallest first
            </button>
            <button
              aria-pressed={sort.direction === 'desc'}
              className="segmented__option"
              onClick={() => setSort({ direction: 'desc' })}
              type="button"
            >
              <span aria-hidden="true">↓ </span>Largest first
            </button>
          </ToggleGroup>
        ) : null}
      </div>

      <div className="filters__row">
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
            Hide drafts
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
            Hide PRs others approved
          </button>
        </ToggleGroup>
      </div>

      <PresetBar
        onClickApplyPreset={onClickApplyPreset}
        onClickDeletePreset={onClickDeletePreset}
        onSavePreset={onSavePreset}
        presets={presets}
        view={view}
      />

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
                    className="chip"
                    onClick={() => setFilters(chip.without)}
                    type="button"
                  >
                    {chip.label} <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="button button--small"
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
