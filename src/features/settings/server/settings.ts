import { join } from 'node:path';
import { z } from 'zod';

import type { ReviewProvider } from '../../../shared/api.ts';
import {
  ensurePrivateDir,
  readIfExists,
  refuseNewerVersion,
  safeJson,
  writePrivateJson,
  WriteQueue,
} from '../../../platform/server/privateFiles.ts';
import { canonicalTimeZone } from '../../../platform/server/timeZone.ts';

const SETTINGS_FILE = 'settings.json';

/** Non-secret preferences; keys live in `SecretStore`. */
export interface AppSettings {
  reviewProvider: ReviewProvider;
  /** Model id per provider; a missing entry means the provider's default. */
  models: Partial<Record<ReviewProvider, string>>;
  /** The player's IANA time zone for streaks and daily achievements; absent means the machine's. */
  timeZone?: string;
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
});

const DEFAULT_SETTINGS: AppSettings = { reviewProvider: 'cursor', models: {} };

/** The review provider and models. `get` is synchronous, so an implementation loads on open. */
export interface SettingsStore {
  get: () => AppSettings;
  update: (patch: SettingsPatch) => Promise<AppSettings>;
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
      return new FileSettingsStore(file, DEFAULT_SETTINGS);
    }
    const json = safeJson(text);
    refuseNewerVersion(json, 1, file);
    const parsed = SettingsFileSchema.safeParse(json);
    if (!parsed.success) {
      options.onWarning?.('The settings file was unreadable; using the defaults');
      return new FileSettingsStore(file, DEFAULT_SETTINGS);
    }
    const settings: AppSettings = {
      reviewProvider: parsed.data.reviewProvider,
      models: parsed.data.models,
    };
    const timeZone = parsed.data.timeZone && canonicalTimeZone(parsed.data.timeZone);
    if (timeZone) {
      settings.timeZone = timeZone;
    }
    return new FileSettingsStore(file, settings);
  }

  public get(): AppSettings {
    return this.current;
  }

  public update(patch: SettingsPatch): Promise<AppSettings> {
    return this.writes.run(async () => {
      const models = { ...this.current.models };
      for (const [provider, model] of Object.entries(patch.models ?? {})) {
        const name = ProviderSchema.parse(provider);
        if (model) {
          models[name] = model;
        } else {
          delete models[name];
        }
      }
      const next: AppSettings = {
        reviewProvider: patch.reviewProvider ?? this.current.reviewProvider,
        models,
      };
      const timeZone = patch.timeZone === undefined ? this.current.timeZone : patch.timeZone;
      if (timeZone) {
        next.timeZone = timeZone;
      }
      await writePrivateJson(this.file, { version: 1, ...next });
      this.current = next;
      return next;
    });
  }
}
