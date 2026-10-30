import { join } from 'node:path';
import { z } from 'zod';

import type { ReviewProvider } from '../shared/api.ts';
import {
  ensurePrivateDir,
  readIfExists,
  safeJson,
  writePrivateJson,
  WriteQueue,
} from './privateFiles.ts';

const SETTINGS_FILE = 'settings.json';

/** Non-secret preferences; keys live in `SecretStore`. */
export interface AppSettings {
  reviewProvider: ReviewProvider;
  /** Model id per provider; a missing entry means the provider's default. */
  models: Partial<Record<ReviewProvider, string>>;
}

export interface SettingsPatch {
  reviewProvider?: ReviewProvider;
  /** `null` clears the model, going back to the provider's default. */
  models?: Partial<Record<ReviewProvider, string | null>>;
}

const ProviderSchema = z.enum(['cursor', 'claude']);

const SettingsFileSchema = z.object({
  version: z.literal(1),
  reviewProvider: ProviderSchema,
  models: z.partialRecord(ProviderSchema, z.string()),
});

const DEFAULT_SETTINGS: AppSettings = { reviewProvider: 'cursor', models: {} };

export interface SettingsStoreOptions {
  onWarning?: (message: string) => void;
}

/** `<stateDir>/settings.json`. Writes are serialized and atomic. */
export class SettingsStore {
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
  ): Promise<SettingsStore> {
    await ensurePrivateDir(stateDir);
    const file = join(stateDir, SETTINGS_FILE);
    const text = await readIfExists(file);
    if (text === undefined) {
      return new SettingsStore(file, DEFAULT_SETTINGS);
    }
    const parsed = SettingsFileSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      options.onWarning?.('The settings file was unreadable; using the defaults');
      return new SettingsStore(file, DEFAULT_SETTINGS);
    }
    return new SettingsStore(file, {
      reviewProvider: parsed.data.reviewProvider,
      models: parsed.data.models,
    });
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
      await writePrivateJson(this.file, { version: 1, ...next });
      this.current = next;
      return next;
    });
  }
}
