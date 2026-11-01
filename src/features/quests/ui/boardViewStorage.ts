import { z } from 'zod';

import type { DifficultyTier } from '../../../shared/api.ts';
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  DEFAULT_VIEW,
  type AgentState,
  type BoardView,
} from './questFilters.ts';

/** Bump the suffix when the stored shape changes incompatibly; old keys are then ignored. */
export const VIEW_STORAGE_KEY = 'pr-quest:board-view:v1';
export const PRESETS_STORAGE_KEY = 'pr-quest:presets:v1';
export const MAX_PRESET_NAME_LENGTH = 40;
export const MAX_PRESETS = 20;
const MAX_SEARCH_LENGTH = 200;

export interface Preset {
  id: string;
  name: string;
  view: BoardView;
  /** Shipped with PR Quest; can't be deleted or overwritten. */
  builtIn: boolean;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const BUILT_IN_PRESETS: ReadonlyArray<Preset> = [
  {
    id: 'builtin:quick-wins',
    name: 'Quick wins',
    builtIn: true,
    view: {
      filters: {
        ...DEFAULT_FILTERS,
        tiers: ['Trivial', 'Normal'],
        hideDrafts: true,
        hideApproved: true,
      },
      sort: { mode: 'size', direction: 'asc' },
    },
  },
  {
    id: 'builtin:boss-rush',
    name: 'Boss rush',
    builtIn: true,
    view: {
      filters: { ...DEFAULT_FILTERS, tiers: ['Hard', 'Boss'] },
      sort: { mode: 'size', direction: 'desc' },
    },
  },
];

const tierSchema = z.enum(['Trivial', 'Normal', 'Hard', 'Boss'] satisfies Array<DifficultyTier>);
const agentStateSchema = z.enum([
  'notStarted',
  'running',
  'lootReady',
  'failed',
] satisfies Array<AgentState>);

/** Each field falls back to its default on its own, so one bad value doesn't reset the rest. */
const ViewSchema = z.object({
  filters: z
    .object({
      search: z.string().max(MAX_SEARCH_LENGTH).catch(DEFAULT_FILTERS.search),
      kind: z.enum(['all', 'direct', 'team']).catch(DEFAULT_FILTERS.kind),
      tiers: z.array(tierSchema).catch([]),
      hideDrafts: z.boolean().catch(DEFAULT_FILTERS.hideDrafts),
      hideApproved: z.boolean().catch(DEFAULT_FILTERS.hideApproved),
      agentStates: z.array(agentStateSchema).catch([]),
    })
    .catch({ ...DEFAULT_FILTERS }),
  sort: z
    .object({
      mode: z.enum(['smart', 'size']).catch(DEFAULT_SORT.mode),
      direction: z.enum(['asc', 'desc']).catch(DEFAULT_SORT.direction),
    })
    .catch({ ...DEFAULT_SORT }),
});

const StoredPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(MAX_PRESET_NAME_LENGTH),
  view: ViewSchema,
});

function readJson(storage: StorageLike | undefined, key: string): unknown {
  try {
    const text = storage?.getItem(key);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(storage: StorageLike | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the board still works, it just won't remember.
  }
}

/** Parses a stored view; anything unreadable falls back to the defaults. */
export function parseView(value: unknown): BoardView {
  const parsed = ViewSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_VIEW;
}

export function loadView(storage: StorageLike | undefined): BoardView {
  return parseView(readJson(storage, VIEW_STORAGE_KEY));
}

export function saveView(storage: StorageLike | undefined, view: BoardView): void {
  writeJson(storage, VIEW_STORAGE_KEY, view);
}

/** The player's own presets; invalid entries are dropped one by one. */
export function loadPresets(storage: StorageLike | undefined): Array<Preset> {
  const value = readJson(storage, PRESETS_STORAGE_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry: unknown) => {
      const parsed = StoredPresetSchema.safeParse(entry);
      return parsed.success && !isBuiltInName(parsed.data.name)
        ? [{ ...parsed.data, builtIn: false }]
        : [];
    })
    .slice(0, MAX_PRESETS);
}

export function savePresets(
  storage: StorageLike | undefined,
  presets: ReadonlyArray<Preset>,
): void {
  writeJson(
    storage,
    PRESETS_STORAGE_KEY,
    presets.filter((preset) => !preset.builtIn).map(({ id, name, view }) => ({ id, name, view })),
  );
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ');

function isBuiltInName(name: string): boolean {
  const key = normalizeName(name).toLowerCase();
  return BUILT_IN_PRESETS.some((preset) => preset.name.toLowerCase() === key);
}

export type AddPresetResult = { presets: Array<Preset>; preset: Preset } | { error: string };

/** Adds a preset, replacing the player's preset of the same name (ignoring case). */
export function addPreset(
  presets: ReadonlyArray<Preset>,
  rawName: string,
  view: BoardView,
): AddPresetResult {
  const name = normalizeName(rawName);
  if (!name) {
    return { error: 'Give the preset a name.' };
  }
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    return { error: `Keep the name under ${MAX_PRESET_NAME_LENGTH + 1} characters.` };
  }
  if (isBuiltInName(name)) {
    return { error: `“${name}” is a built-in preset. Pick another name.` };
  }
  const key = name.toLowerCase();
  const others = presets.filter((existing) => existing.name.toLowerCase() !== key);
  if (others.length >= MAX_PRESETS) {
    return { error: `You can keep up to ${MAX_PRESETS} presets. Delete one first.` };
  }
  const preset: Preset = { id: `user:${key}`, name, view, builtIn: false };
  return { presets: [...others, preset], preset };
}

/** Removes one of the player's presets; built-in presets are never removed. */
export function removePreset(presets: ReadonlyArray<Preset>, id: string): Array<Preset> {
  return presets.filter((preset) => preset.builtIn || preset.id !== id);
}
