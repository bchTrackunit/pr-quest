import { join } from 'node:path';
import { z } from 'zod';

import type { ReviewProvider } from '@pr-quest/contract/api';
import type { DocumentCodec } from '../../platform/documentCodec.ts';
import {
  ensurePrivateDir,
  readIfExists,
  refuseNewerVersion,
  safeJson,
  writePrivateJson,
  WriteQueue,
} from '../../platform/privateFiles.ts';
import { canonicalTimeZone } from '../../platform/timeZone.ts';

const SETTINGS_FILE = 'settings.json';

/** Non-secret preferences; keys live in `SecretStore`. */
export interface AppSettings {
  reviewProvider: ReviewProvider;
  /** Model id per provider; a missing entry means the provider's default. */
  models: Partial<Record<ReviewProvider, string>>;
  /** The player's IANA time zone for streaks and daily achievements; absent means the machine's. */
  timeZone?: string;
  /** When `timeZone` last changed, as an ISO timestamp, so changes can be limited. */
  timeZoneChangedAt?: string;
}

export interface SettingsPatch {
  reviewProvider?: ReviewProvider;
  /** `null` clears the model, going back to the provider's default. */
  models?: Partial<Record<ReviewProvider, string | null>>;
  /** A canonical IANA zone name; `null` goes back to the machine's zone. */
  timeZone?: string | null;
}

const ProviderSchema = z.enum(['cursor', 'claude']);

const SettingsFileSchema = z.object({
  version: z.literal(1),
  reviewProvider: ProviderSchema,
  models: z.partialRecord(ProviderSchema, z.string()),
  /** Older builds drop it on their next write, which only resets the zone to the machine's. */
  timeZone: z.string().optional().catch(undefined),
  timeZoneChangedAt: z.iso.datetime().optional().catch(undefined),
});

const DEFAULT_SETTINGS: AppSettings = { reviewProvider: 'cursor', models: {} };

/** Settings as a version 1 JSON document, wherever it is saved. */
export const SETTINGS_DOCUMENT: DocumentCodec<AppSettings> = {
  version: 1,
  empty: () => DEFAULT_SETTINGS,
  decode: (json) => {
    const parsed = SettingsFileSchema.safeParse(json);
    if (!parsed.success) {
      return undefined;
    }
    const settings: AppSettings = {
      reviewProvider: parsed.data.reviewProvider,
      models: parsed.data.models,
    };
    const timeZone = parsed.data.timeZone && canonicalTimeZone(parsed.data.timeZone);
    if (timeZone) {
      settings.timeZone = timeZone;
    }
    if (parsed.data.timeZoneChangedAt) {
      settings.timeZoneChangedAt = parsed.data.timeZoneChangedAt;
    }
    return settings;
  },
  encode: (settings) => ({ version: 1, ...settings }),
};

export interface SettingsUpdateOptions {
  /** When the update happens, for stamping a changed time zone; defaults to the clock. */
  now?: Date;
  /** Refuses a time zone change sooner than this after the previous one. */
  minTimeZoneIntervalMs?: number;
}

/** A time zone change came sooner than `SettingsUpdateOptions.minTimeZoneIntervalMs` allows. */
export class TimeZoneChangeTooSoon extends Error {
  public readonly allowedAt: Date;

  public constructor(allowedAt: Date) {
    super(`The time zone can change once a day; try again after ${allowedAt.toISOString()}`);
    this.name = 'TimeZoneChangeTooSoon';
    this.allowedAt = allowedAt;
  }
}

/**
 * `current` with `patch` applied; models set to `null` and a `null` zone are cleared. A zone that
 * changes is stamped with `options.now`. Throws `TimeZoneChangeTooSoon` when the zone changes
 * sooner than `options.minTimeZoneIntervalMs` allows.
 */
export function applySettingsPatch(
  current: AppSettings,
  patch: SettingsPatch,
  options: SettingsUpdateOptions = {},
): AppSettings {
  const now = options.now ?? new Date();
  if (options.minTimeZoneIntervalMs !== undefined) {
    const allowedAt = timeZoneChangeAllowedAt(current, patch, {
      minIntervalMs: options.minTimeZoneIntervalMs,
      now,
    });
    if (allowedAt) {
      throw new TimeZoneChangeTooSoon(allowedAt);
    }
  }
  const models = { ...current.models };
  for (const [provider, model] of Object.entries(patch.models ?? {})) {
    const name = ProviderSchema.parse(provider);
    if (model) {
      models[name] = model;
    } else {
      delete models[name];
    }
  }
  const next: AppSettings = {
    reviewProvider: patch.reviewProvider ?? current.reviewProvider,
    models,
  };
  const timeZone = patch.timeZone === undefined ? current.timeZone : (patch.timeZone ?? undefined);
  if (timeZone) {
    next.timeZone = timeZone;
  }
  const changedAt = timeZone === current.timeZone ? current.timeZoneChangedAt : now.toISOString();
  if (changedAt) {
    next.timeZoneChangedAt = changedAt;
  }
  return next;
}

/**
 * When `patch` may change `current`'s time zone, if it changes the zone sooner than `minIntervalMs`
 * after the last change; otherwise `undefined`.
 */
function timeZoneChangeAllowedAt(
  current: AppSettings,
  patch: SettingsPatch,
  limit: { minIntervalMs: number; now: Date },
): Date | undefined {
  if (patch.timeZone === undefined || (patch.timeZone ?? undefined) === current.timeZone) {
    return undefined;
  }
  const last = current.timeZoneChangedAt ? Date.parse(current.timeZoneChangedAt) : Number.NaN;
  const allowedAt = last + limit.minIntervalMs;
  return allowedAt > limit.now.getTime() ? new Date(allowedAt) : undefined;
}

/** The review provider, models and time zone. `get` is synchronous, so an implementation loads on open. */
export interface SettingsStore {
  get: () => AppSettings;
  /** Applies `patch` to the latest saved settings with `applySettingsPatch`, and saves them. */
  update: (patch: SettingsPatch, options?: SettingsUpdateOptions) => Promise<AppSettings>;
}

export interface SettingsStoreOptions {
  onWarning?: (message: string) => void;
}

/** `<stateDir>/settings.json`. Writes are serialized and atomic. */
export class FileSettingsStore implements SettingsStore {
  private readonly file: string;
  private readonly writes = new WriteQueue();
  private current: AppSettings;

  private constructor(file: string, current: AppSettings) {
    this.file = file;
    this.current = current;
  }

  public static async open(
    stateDir: string,
    options: SettingsStoreOptions = {},
  ): Promise<FileSettingsStore> {
    await ensurePrivateDir(stateDir);
    const file = join(stateDir, SETTINGS_FILE);
    const text = await readIfExists(file);
    if (text === undefined) {
      return new FileSettingsStore(file, SETTINGS_DOCUMENT.empty());
    }
    const json = safeJson(text);
    refuseNewerVersion(json, SETTINGS_DOCUMENT.version, file);
    const settings = SETTINGS_DOCUMENT.decode(json);
    if (!settings) {
      options.onWarning?.('The settings file was unreadable; using the defaults');
      return new FileSettingsStore(file, SETTINGS_DOCUMENT.empty());
    }
    return new FileSettingsStore(file, settings);
  }

  public get(): AppSettings {
    return this.current;
  }

  public update(patch: SettingsPatch, options?: SettingsUpdateOptions): Promise<AppSettings> {
    return this.writes.run(async () => {
      const next = applySettingsPatch(this.current, patch, options);
      await writePrivateJson(this.file, SETTINGS_DOCUMENT.encode(next));
      this.current = next;
      return next;
    });
  }
}
