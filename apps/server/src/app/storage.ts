import { FileStateStore, type StateStore } from '../features/game/index.ts';
import { FileQuestCache, type QuestCache } from '../features/quests/index.ts';
import { FileSettingsStore, type SettingsStore } from '../features/settings/index.ts';
import { FileSecretStore, type SecretStore } from '../platform/secrets.ts';
import { migrateLegacyState, userStateDir } from './userState.ts';

/**
 * Whose API keys and settings. Local mode keeps one set per machine, shared by every GitHub account
 * that signs in there; a hosted server keeps one set per signed-in user.
 */
export type StorageScope =
  | { readonly kind: 'machine' }
  | { readonly kind: 'user'; readonly login: string };

export const MACHINE_SCOPE: StorageScope = { kind: 'machine' };

/** GitHub logins are case-insensitive, so a scope always holds the lower-cased one. */
export function userScope(login: string): StorageScope {
  return { kind: 'user', login: login.toLowerCase() };
}

export function scopeKey(scope: StorageScope): string {
  return scope.kind === 'machine' ? 'machine' : `user:${scope.login}`;
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
  /** `login`'s XP, achievements and review runs. */
  gameState: (login: string) => Promise<StateStore>;
  /** `login`'s last quest list and any rate-limit backoff. */
  questCache: (login: string) => Promise<QuestCache>;
}

export interface FileStorageOptions {
  info: (message: string) => void;
  warn: (message: string) => void;
  /** Keeps the machine's secrets here instead of in `secrets.json`, e.g. encrypted by the OS. */
  secrets?: SecretStore;
}

/**
 * The JSON files in the state directory. Keys and settings are per machine, in `secrets.json` and
 * `settings.json`; each player's game and quest cache live in `users/<login>/`. A user scope is
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
    gameState: async (login) => {
      const dir = userStateDir(stateDir, login);
      const { migrated } = await migrateLegacyState(stateDir, login, { onWarning: warn });
      if (migrated.length > 0) {
        info(
          `Moved ${migrated.join(' and ')} into ${login}'s folder; the originals are kept as .bak files`,
        );
      }
      return FileStateStore.open(dir, { onWarning: warn });
    },
    questCache: async (login) =>
      new FileQuestCache(userStateDir(stateDir, login), { onWarning: warn }),
  };
}

function assertMachineScope(scope: StorageScope): void {
  if (scope.kind !== 'machine') {
    throw new Error(
      `The file storage keeps only the machine's keys and settings, not per-user ones for ${scope.login}; inject a storage that has them`,
    );
  }
}
