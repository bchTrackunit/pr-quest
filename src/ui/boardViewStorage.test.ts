import { describe, expect, test } from 'vitest';

import {
  addPreset,
  BUILT_IN_PRESETS,
  loadPresets,
  loadView,
  MAX_PRESETS,
  parseView,
  PRESETS_STORAGE_KEY,
  removePreset,
  savePresets,
  saveView,
  VIEW_STORAGE_KEY,
  type Preset,
  type StorageLike,
} from './boardViewStorage.ts';
import { DEFAULT_FILTERS, DEFAULT_VIEW, type BoardView } from './questFilters.ts';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const VIEW: BoardView = {
  filters: {
    search: 'fleet',
    kind: 'direct',
    tiers: ['Hard'],
    hideDrafts: true,
    hideApproved: false,
    agentStates: ['failed'],
  },
  sort: { mode: 'size', direction: 'desc' },
};

describe('board view persistence', () => {
  test('uses versioned keys', () => {
    expect(VIEW_STORAGE_KEY).toMatch(/:v\d+$/);
    expect(PRESETS_STORAGE_KEY).toMatch(/:v\d+$/);
  });

  test('round-trips the view', () => {
    const storage = memoryStorage();

    saveView(storage, VIEW);

    expect(loadView(storage)).toEqual(VIEW);
  });

  test.each([
    ['nothing stored', undefined],
    ['invalid JSON', '{nope'],
    ['a string', '"hello"'],
    ['null', 'null'],
  ])('falls back to the defaults for %s', (_name, text) => {
    const storage = memoryStorage(text === undefined ? {} : { [VIEW_STORAGE_KEY]: text });
    expect(loadView(storage)).toEqual(DEFAULT_VIEW);
  });

  test('replaces only the fields that are bad', () => {
    expect(
      parseView({
        filters: { ...VIEW.filters, kind: 'everyone', tiers: ['Hard', 'Legendary'], hideDrafts: 1 },
        sort: { mode: 'size', direction: 'sideways' },
      }),
    ).toEqual({
      filters: { ...VIEW.filters, kind: 'all', tiers: [], hideDrafts: false },
      sort: { mode: 'size', direction: 'asc' },
    });
    expect(parseView({ filters: 'oops' })).toEqual(DEFAULT_VIEW);
  });

  test('survives storage that throws', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };

    expect(loadView(broken)).toEqual(DEFAULT_VIEW);
    expect(() => saveView(broken, VIEW)).not.toThrow();
    expect(loadView(undefined)).toEqual(DEFAULT_VIEW);
  });
});

describe('presets', () => {
  test('ships Quick wins and Boss rush as built-ins', () => {
    expect(BUILT_IN_PRESETS.map((preset) => [preset.name, preset.builtIn])).toEqual([
      ['Quick wins', true],
      ['Boss rush', true],
    ]);
    expect(BUILT_IN_PRESETS[0]?.view).toEqual({
      filters: {
        ...DEFAULT_FILTERS,
        tiers: ['Trivial', 'Normal'],
        hideDrafts: true,
        hideApproved: true,
      },
      sort: { mode: 'size', direction: 'asc' },
    });
    expect(BUILT_IN_PRESETS[1]?.view).toEqual({
      filters: { ...DEFAULT_FILTERS, tiers: ['Hard', 'Boss'] },
      sort: { mode: 'size', direction: 'desc' },
    });
  });

  test('saves, reloads and deletes a preset', () => {
    const storage = memoryStorage();
    const added = addPreset([], '  Morning   sweep ', VIEW);
    if ('error' in added) {
      throw new Error(added.error);
    }

    savePresets(storage, added.presets);
    const loaded = loadPresets(storage);

    expect(loaded).toEqual([
      { id: 'user:morning sweep', name: 'Morning sweep', view: VIEW, builtIn: false },
    ]);
    expect(removePreset(loaded, 'user:morning sweep')).toEqual([]);
  });

  test('replaces a preset with the same name, ignoring case', () => {
    const first = addPreset([], 'Mine', DEFAULT_VIEW);
    if ('error' in first) {
      throw new Error(first.error);
    }

    const second = addPreset(first.presets, 'MINE', VIEW);

    expect('presets' in second && second.presets).toEqual([
      { id: 'user:mine', name: 'MINE', view: VIEW, builtIn: false },
    ]);
  });

  test.each([
    ['an empty name', '   ', /name/],
    ['a built-in name', 'quick WINS', /built-in/],
    ['a name that is too long', 'x'.repeat(41), /under 41/],
  ])('rejects %s', (_name, name, message) => {
    const result = addPreset([], name, VIEW);
    expect('error' in result && result.error).toMatch(message);
  });

  test(`keeps at most ${MAX_PRESETS} presets`, () => {
    const full: Array<Preset> = Array.from({ length: MAX_PRESETS }, (_, index) => ({
      id: `user:p${index}`,
      name: `p${index}`,
      view: DEFAULT_VIEW,
      builtIn: false,
    }));

    expect(addPreset(full, 'one more', VIEW)).toMatchObject({
      error: expect.stringMatching(/Delete one/),
    });
    expect('presets' in addPreset(full, 'P3', VIEW)).toBe(true);
  });

  test('never removes or stores built-in presets', () => {
    const storage = memoryStorage();
    const builtIn = BUILT_IN_PRESETS.find((preset) => preset.id === 'builtin:quick-wins');
    if (!builtIn) {
      throw new Error('missing built-in');
    }

    expect(removePreset([builtIn], builtIn.id)).toEqual([builtIn]);
    savePresets(storage, [builtIn]);
    expect(JSON.parse(storage.data[PRESETS_STORAGE_KEY] ?? 'null')).toEqual([]);
  });

  test('drops bad stored entries one by one and ignores built-in names', () => {
    const storage = memoryStorage({
      [PRESETS_STORAGE_KEY]: JSON.stringify([
        { id: 'user:ok', name: 'OK', view: VIEW },
        { id: 'user:bad', name: '' },
        'junk',
        { id: 'user:boss rush', name: 'Boss rush', view: VIEW },
      ]),
    });

    expect(loadPresets(storage).map((preset) => preset.name)).toEqual(['OK']);
    expect(loadPresets(memoryStorage({ [PRESETS_STORAGE_KEY]: '{"not":"a list"}' }))).toEqual([]);
  });
});
