import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { type AppOptions, createApp, type UserServices } from './app.ts';
import { readGhToken } from '../../features/auth/server/index.ts';
import type { AppConfig } from '../../platform/server/config.ts';
import {
  createRouter,
  type RequestListener,
  trustedRequests,
} from '../../platform/server/router.ts';
import type { SecretStore } from '../../platform/server/secrets.ts';
import type { IdentityFactory } from './identity.ts';
import { type AppStorage, createFileStorage } from './storage.ts';

export { type AppConfig, loadConfig } from '../../platform/server/config.ts';
export type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
export type { IdentityContext, IdentityFactory, IdentityResolver } from './identity.ts';
export {
  type AppStorage,
  createFileStorage,
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
  /** Replaces the JSON files in the state directory, e.g. with a database. */
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
  if (config.mode === 'hosted' && (!overrides.identity || !overrides.storage)) {
    throw new Error(
      "Hosted mode needs an identity resolver and storage for many users. This build only has local mode's, which would let anyone act as the server's GitHub account.",
    );
  }
  const staticDir = usableStaticDir(overrides.staticDir, warn);

  const app = await createApp({
    config,
    storage:
      overrides.storage ??
      (overrides.secrets
        ? createFileStorage(config.stateDir, { info, warn, secrets: overrides.secrets })
        : undefined),
    identity: overrides.identity,
    ghToken: overrides.ghToken ?? readGhToken,
    fetch: overrides.fetch,
    createMessage: overrides.createMessage,
    listCursorModels: overrides.listCursorModels,
    info,
    warn,
  });

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
    throw error;
  }
  routing.router = createRouter(app.handlers, {
    ...trustedRequests(config, port),
    staticDir,
    onUnexpectedError: (error) => {
      warn(`unexpected error ${inspect(error)}`);
    },
  });

  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  info(`${staticDir ? 'PR Quest' : 'API'} listening on ${url}`);
  info(`state in ${config.stateDir}`);
  void app.warmUp();

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        app.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
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
