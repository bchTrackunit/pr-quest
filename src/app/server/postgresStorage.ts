import {
  type PersistedState,
  STATE_DOCUMENT,
  type StateStore,
} from '../../features/game/server/index.ts';
import { type QuestCache, QUEST_CACHE_DOCUMENT } from '../../features/quests/server/index.ts';
import {
  type AppSettings,
  applySettingsPatch,
  SETTINGS_DOCUMENT,
  type SettingsStore,
} from '../../features/settings/server/index.ts';
import type { MasterKeyring } from '../../platform/server/envelope.ts';
import type { Database } from '../../platform/server/postgres/database.ts';
import {
  ensureUser,
  PostgresDocument,
  readDocument,
  writeDocument,
} from '../../platform/server/postgres/documents.ts';
import { assertSchemaCurrent } from '../../platform/server/postgres/migrations.ts';
import { PostgresSecretStore } from '../../platform/server/postgres/secrets.ts';
import { WriteQueue } from '../../platform/server/privateFiles.ts';
import type { AppStorage, StorageScope } from './storage.ts';
import { githubLogin } from './userState.ts';

export interface PostgresStorageOptions {
  /** Wraps each user's data key; see `envelope.ts`. */
  keyring: MasterKeyring;
  warn: (message: string) => void;
}

/** `user_documents.kind` of each document. */
const KINDS = { settings: 'settings', game: 'game', quests: 'quests' } as const;

/**
 * Hosted storage: one JSON row per user and document in Postgres, using the same versioned codecs
 * as the state files, and each user's API keys under envelope encryption. Rejects when the schema
 * isn't exactly this build's, so run the migrations first. Keys and settings are per user, so the
 * machine scope is refused, as hosted mode never opens it.
 */
export async function openPostgresStorage(
  db: Database,
  options: PostgresStorageOptions,
): Promise<AppStorage> {
  await assertSchemaCurrent(db);
  const { keyring, warn } = options;
  const document = { onWarning: warn };
  return {
    secrets: async (scope) => PostgresSecretStore.open(db, githubLogin(userLogin(scope)), keyring),
    settings: async (scope) => {
      const key = { login: githubLogin(userLogin(scope)), kind: KINDS.settings };
      return settingsStore(await PostgresDocument.open(db, key, SETTINGS_DOCUMENT, document));
    },
    gameState: async (login) => {
      const key = { login: githubLogin(login), kind: KINDS.game };
      return stateStore(await PostgresDocument.open(db, key, STATE_DOCUMENT, document));
    },
    questCache: async (login) => {
      const key = { login: githubLogin(login), kind: KINDS.quests };
      await ensureUser(db, key.login);
      return questCache(db, key, warn);
    },
  };
}

function userLogin(scope: StorageScope): string {
  if (scope.kind !== 'user') {
    throw new Error(
      "The Postgres storage keeps keys and settings per user, not the machine's; use a user scope",
    );
  }
  return scope.login;
}

function settingsStore(document: PostgresDocument<AppSettings>): SettingsStore {
  return {
    get: () => document.value,
    update: (patch) => document.update((current) => applySettingsPatch(current, patch)),
  };
}

function stateStore(document: PostgresDocument<PersistedState>): StateStore {
  return {
    get state() {
      return document.value;
    },
    update: (mutate) => document.update(mutate),
  };
}

/** The last write wins, as with the cache file: losing an update only costs a refresh. */
function questCache(
  db: Database,
  key: { login: string; kind: string },
  warn: (message: string) => void,
): QuestCache {
  const writes = new WriteQueue();
  return {
    load: async () => {
      let json: unknown;
      try {
        json = await readDocument(db, key);
      } catch (error) {
        warn(
          `Could not read the quest cache: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {};
      }
      if (json === undefined) {
        return {};
      }
      const state = QUEST_CACHE_DOCUMENT.decode(json);
      if (!state) {
        warn(`${key.login}'s quest cache was unreadable; ignoring it`);
        return {};
      }
      return state;
    },
    save: (state) => writes.run(() => writeDocument(db, key, QUEST_CACHE_DOCUMENT.encode(state))),
  };
}
