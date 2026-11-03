import { FileStateStore, type StateStore } from '../features/game/index.ts';
import { FileQuestCache, type QuestCache } from '../features/quests/index.ts';
import { FileSettingsStore, type SettingsStore } from '../features/settings/index.ts';
import { type GitHubUser, githubUser } from '../platform/githubUser.ts';
import { FileSecretStore, type SecretStore } from '../platform/secrets.ts';
import { migrateLegacyState, userStateDir } from './userState.ts';

/**
 * Whose API keys and settings. Local mode keeps one set per machine, shared by every GitHub account
 * that signs in there; a hosted server keeps one set per signed-in user.
 */
export type StorageScope =
  | { readonly kind: 'machine' }
  | { readonly kind: 'user'; readonly user: GitHubUser };

export type { GitHubUser };
export { githubUser };

export const MACHINE_SCOPE: StorageScope = { kind: 'machine' };

/**
 * A signed-in user's scope. Hosted data belongs to `user.id`, which never changes; the login can be
 * renamed and taken by another account. The login is lower-cased, as logins are case-insensitive.
 */
export function userScope(user: GitHubUser): StorageScope {
  return { kind: 'user', user: githubUser(user.id, user.login) };
}

export function scopeKey(scope: StorageScope): string {
  return scope.kind === 'machine' ? 'machine' : `user:${scope.user.id}`;
}

/**
 * Everything PR Quest saves. The app opens each scope's stores and each player's game once and
 * keeps them, so an implementation may open a fresh copy per call.
 */
export interface AppStorage {
  /** The API keys of `scope`. In local mode the machine's store also holds the GitHub OAuth token. */
  secrets: (scope: StorageScope) => Promise<SecretStore>;
  /** The review provider and models of `scope`. */
  settings: (scope: StorageScope) => Promise<SettingsStore>;
  /** `user`'s XP, achievements and review runs. */
  gameState: (user: GitHubUser) => Promise<StateStore>;
  /** `user`'s last quest list and any rate-limit backoff. */
  questCache: (user: GitHubUser) => Promise<QuestCache>;
  /**
   * Records `user`'s current login, which may have changed since another server or session last
   * saw it. The app calls it whenever it opens a session; storage keyed by login needs none.
   */
  registerUser?: (user: GitHubUser) => Promise<void>;
}

export interface FileStorageOptions {
  info: (message: string) => void;
  warn: (message: string) => void;
  /** Keeps the machine's secrets here instead of in `secrets.json`, e.g. encrypted by the OS. */
  secrets?: SecretStore;
}

/**
 * The JSON files in the state directory. Keys and settings are per machine, in `secrets.json` and
 * `settings.json`; each player's game and quest cache live in `users/<login>/`, as a local machine
 * has no other owner of that login. A user scope is
 * refused, because the machine's secrets hold the local player's GitHub token.
 */
export function createFileStorage(stateDir: string, options: FileStorageOptions): AppStorage {
  const { info, warn } = options;
  let secrets: Promise<SecretStore> | undefined;
  let settings: Promise<SettingsStore> | undefined;
  return {
    secrets: async (scope) => {
      assertMachineScope(scope);
      secrets ??=
        options.secrets === undefined
          ? FileSecretStore.open(stateDir, { onWarning: warn })
          : Promise.resolve(options.secrets);
      return secrets;
    },
    settings: async (scope) => {
      assertMachineScope(scope);
      settings ??= FileSettingsStore.open(stateDir, { onWarning: warn });
      return settings;
    },
    gameState: async ({ login }) => {
      const dir = userStateDir(stateDir, login);
      const { migrated } = await migrateLegacyState(stateDir, login, { onWarning: warn });
      if (migrated.length > 0) {
        info(
          `Moved ${migrated.join(' and ')} into ${login}'s folder; the originals are kept as .bak files`,
        );
      }
      return FileStateStore.open(dir, { onWarning: warn });
    },
    questCache: async ({ login }) =>
      new FileQuestCache(userStateDir(stateDir, login), { onWarning: warn }),
  };
}

function assertMachineScope(scope: StorageScope): void {
  if (scope.kind !== 'machine') {
    throw new Error(
      `The file storage keeps only the machine's keys and settings, not per-user ones for ${scope.user.login}; inject a storage that has them`,
    );
  }
}
