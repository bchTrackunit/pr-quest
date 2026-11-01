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
import { type GitHubUser, githubUser } from '../../platform/server/githubUser.ts';
import type { Database } from '../../platform/server/postgres/database.ts';
import {
  type DocumentKey,
  ensureUser,
  PostgresDocument,
  readDocument,
  userLabel,
  writeDocument,
} from '../../platform/server/postgres/documents.ts';
import { assertSchemaCurrent, MIGRATIONS } from '../../platform/server/postgres/migrations.ts';
import { PostgresSecretStore } from '../../platform/server/postgres/secrets.ts';
import { WriteQueue } from '../../platform/server/privateFiles.ts';
import type { AppStorage, StorageScope } from './storage.ts';

export interface PostgresStorageOptions {
  /** Wraps each user's data key; see `envelope.ts`. */
  keyring: MasterKeyring;
  warn: (message: string) => void;
}

/** `user_documents.kind` of each document. */
const KINDS = { settings: 'settings', game: 'game', quests: 'quests' } as const;

/**
 * Hosted storage: one JSON row per user and document in Postgres, using the same versioned codecs
 * as the state files, and each user's API keys under envelope encryption. Rejects until this build's
 * migrations have run, and when a newer build made a breaking schema change. Rows belong to the
 * user's GitHub account id; a login another account held before is taken from it, so a reused login
 * never inherits data. Keys and settings are per user, so the machine scope is refused, as hosted
 * mode never opens it.
 */
export async function openPostgresStorage(
  db: Database,
  options: PostgresStorageOptions,
): Promise<AppStorage> {
  const { keyring, warn } = options;
  await assertSchemaCurrent(db, MIGRATIONS, { onWarning: warn });
  const document = { onWarning: warn };
  const registered = new Map<string, Promise<GitHubUser>>();
  /** Records `user`'s current login once per id and login this process sees. */
  const register = async (given: GitHubUser): Promise<GitHubUser> => {
    const user = githubUser(given.id, given.login);
    const key = `${user.id}:${user.login}`;
    let pending = registered.get(key);
    if (!pending) {
      pending = ensureUser(db, user).then(({ detachedFrom }) => {
        if (detachedFrom !== undefined) {
          warn(
            `The login ${user.login} now belongs to GitHub id ${user.id}; the account that held it before (GitHub id ${detachedFrom}) keeps its data until it signs in under its new login`,
          );
        }
        return user;
      });
      registered.set(key, pending);
      pending.catch(() => registered.delete(key));
    }
    return await pending;
  };
  const keyOf = async (user: GitHubUser, kind: string): Promise<DocumentKey> => ({
    user: await register(user),
    kind,
  });
  return {
    secrets: async (scope) =>
      PostgresSecretStore.open(db, await register(userOf(scope)), keyring, document),
    settings: async (scope) => {
      const key = await keyOf(userOf(scope), KINDS.settings);
      return settingsStore(await PostgresDocument.open(db, key, SETTINGS_DOCUMENT, document));
    },
    gameState: async (user) => {
      const key = await keyOf(user, KINDS.game);
      return stateStore(await PostgresDocument.open(db, key, STATE_DOCUMENT, document));
    },
    questCache: async (user) => questCache(db, await keyOf(user, KINDS.quests), warn),
  };
}

function userOf(scope: StorageScope): GitHubUser {
  if (scope.kind !== 'user') {
    throw new Error(
      "The Postgres storage keeps keys and settings per user, not the machine's; use a user scope",
    );
  }
  return scope.user;
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
function questCache(db: Database, key: DocumentKey, warn: (message: string) => void): QuestCache {
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
        warn(`${userLabel(key.user)}'s quest cache was unreadable; ignoring it`);
        return {};
      }
      return state;
    },
    save: (state) => writes.run(() => writeDocument(db, key, QUEST_CACHE_DOCUMENT.encode(state))),
  };
}
