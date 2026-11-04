import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { type App, type AppOptions, createApp, type UserServices } from './app.ts';
import { readGhToken } from '../features/auth/index.ts';
import {
  type AppConfig,
  assertSafeConfig,
  type DatabaseConfig,
  LOOPBACK_HOSTNAMES,
} from '../platform/config.ts';
import { connectPostgres, type Database, transportWarning } from '../platform/postgres/database.ts';
import { openPostgresStorage } from './postgresStorage.ts';
import { createRouter, type RequestListener, trustedRequests } from '../platform/router.ts';
import type { SecretStore } from '../platform/secrets.ts';
import type { IdentityFactory } from './identity.ts';
import { type AppStorage, createFileStorage } from './storage.ts';

export {
  type AppConfig,
  type HostedConfig,
  loadConfig,
  type LocalConfig,
} from '../platform/config.ts';
export { MasterKeyring } from '../platform/envelope.ts';
export type { SecretName, SecretStore } from '../platform/secrets.ts';
export type {
  DeviceSignIn,
  IdentityContext,
  IdentityFactory,
  IdentityResolver,
} from './identity.ts';
export type { RawRoute } from '../platform/router.ts';
export type { SharedDatabase, SqlClient, SqlResult } from '../platform/postgres/database.ts';
export {
  type AppStorage,
  createFileStorage,
  type GitHubUser,
  githubUser,
  MACHINE_SCOPE,
  type StorageScope,
  userScope,
} from './storage.ts';
export type { UserServices } from './app.ts';

/** What an embedding process can swap in. Everything is optional in local mode. */
export interface ServerOverrides extends Pick<
  AppOptions,
  'fetch' | 'createMessage' | 'listCursorModels'
> {
  /**
   * Replaces the JSON files in the state directory. Hosted mode otherwise uses the Postgres
   * database in `config.database`.
   */
  storage?: AppStorage;
  /**
   * Keeps the JSON files but saves the machine's secrets here instead of in `secrets.json`, e.g.
   * encrypted with the OS keychain. Ignored when `storage` is given.
   */
  secrets?: SecretStore;
  /** Who each request acts as. Hosted mode requires one; local mode defaults to its single player. */
  identity?: IdentityFactory<UserServices>;
  /** Serves the built UI (`dist/`) from this directory, on the API's port. */
  staticDir?: string;
  /**
   * Development only: also trusts the Vite dev server's origin on `config.uiPort`, which proxies
   * `/api` here. Without it, the server trusts only its own origin.
   */
  devUiOrigin?: boolean;
  /** Defaults to running `gh auth token`. */
  ghToken?: () => Promise<string | undefined>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface RunningServer {
  /** Where the server listens, such as `http://127.0.0.1:53124`. */
  url: string;
  port: number;
  /** Stops polling and background work, then closes every connection. */
  close: () => Promise<void>;
}

const defaultInfo = (message: string): void => {
  process.stdout.write(`[pr-quest] ${message}\n`);
};
const defaultWarn = (message: string): void => {
  process.stderr.write(`[pr-quest] ${message}\n`);
};

/**
 * Starts PR Quest in this process. With `config.port` 0 it listens on a free port, and the router
 * trusts that port's origin once it is known, so an embedding app can open `url` directly.
 */
export async function startServer(
  config: AppConfig,
  overrides: ServerOverrides = {},
): Promise<RunningServer> {
  const info = overrides.info ?? defaultInfo;
  const warn = overrides.warn ?? defaultWarn;
  assertSafeConfig(config);
  if (config.mode === 'hosted' && isPlainHttpOrigin(config.publicOrigin)) {
    warn(
      `PR_QUEST_PUBLIC_ORIGIN ${config.publicOrigin} is plain HTTP, so session cookies and API keys cross the network unencrypted. Serve it over HTTPS.`,
    );
  }
  if (config.mode === 'hosted' && !overrides.identity) {
    throw new Error(
      "Hosted mode needs an identity resolver for many users. This build only has local mode's, which would let anyone act as the server's GitHub account.",
    );
  }
  if (config.mode === 'hosted' && !overrides.storage && !config.database) {
    throw new Error(
      'Hosted mode needs storage for many users: set DATABASE_URL and PR_QUEST_MASTER_KEY.',
    );
  }
  const staticDir = usableStaticDir(overrides.staticDir, warn);
  const database =
    config.mode === 'hosted' && !overrides.storage && config.database
      ? await openDatabase(config.database, warn)
      : undefined;

  let app: App;
  try {
    app = await createApp({
      config,
      storage:
        overrides.storage ??
        database?.storage ??
        (overrides.secrets
          ? createFileStorage(config.stateDir, { info, warn, secrets: overrides.secrets })
          : undefined),
      database: database?.db,
      identity: overrides.identity,
      ghToken: overrides.ghToken ?? readGhToken,
      fetch: overrides.fetch,
      createMessage: overrides.createMessage,
      listCursorModels: overrides.listCursorModels,
      info,
      warn,
    });
  } catch (error) {
    await database?.db.close();
    throw error;
  }

  // The router needs the port, which port 0 only reveals once the server listens.
  const routing: { router?: RequestListener } = {};
  const server = createServer((req, res) => {
    if (routing.router) {
      routing.router(req, res);
      return;
    }
    res.writeHead(503).end();
  });
  let port: number;
  try {
    port = await listen(server, config.port, config.host);
  } catch (error) {
    app.close();
    await database?.db.close();
    throw error;
  }
  routing.router = createRouter(app.handlers, {
    ...trustedRequests(config, port, { devUiOrigin: overrides.devUiOrigin }),
    staticDir,
    routes: app.routes,
    onUnexpectedError: (error) => {
      warn(`unexpected error ${inspect(error)}`);
    },
  });

  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  info(`${staticDir ? 'PR Quest' : 'API'} listening on ${url}`);
  info(database ? 'state in Postgres' : `state in ${config.stateDir}`);
  void app.warmUp();

  return {
    url,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        app.close();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await database?.db.close();
    },
  };
}

/** Connects to hosted mode's database; rejects, closing the pool, when it is unusable. */
async function openDatabase(
  config: DatabaseConfig,
  warn: (message: string) => void,
): Promise<{ db: Database; storage: AppStorage }> {
  const transport = transportWarning(config.url);
  if (transport) {
    warn(transport);
  }
  const db = connectPostgres(config.url, { max: config.poolMax, onError: warn });
  try {
    return { db, storage: await openPostgresStorage(db, { keyring: config.keyring, warn }) };
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** HTTP to anything but this machine, where nothing protects what travels over it. */
function isPlainHttpOrigin(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return (
    protocol === 'http:' &&
    !LOOPBACK_HOSTNAMES.some((name) => name === hostname) &&
    hostname !== '[::1]'
  );
}

function usableStaticDir(
  dir: string | undefined,
  warn: (message: string) => void,
): string | undefined {
  if (dir === undefined) {
    return undefined;
  }
  if (!existsSync(join(dir, 'index.html'))) {
    warn(`No UI build in ${dir}; serving the API only. Run \`yarn build\` to build the UI.`);
    return undefined;
  }
  return dir;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve(address.port);
      } else {
        reject(new Error('The server is not listening on a TCP port'));
      }
    });
  });
}
