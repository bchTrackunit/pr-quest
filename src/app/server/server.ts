import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { type AppOptions, createApp, type UserServices } from './app.ts';
import { readGhToken } from '../../features/auth/server/index.ts';
import {
  type AppConfig,
  assertSafeConfig,
  LOOPBACK_HOSTNAMES,
} from '../../platform/server/config.ts';
import { bootstrapRoute } from '../../platform/server/bootstrap.ts';
import {
  createRouter,
  type RawRoute,
  type RequestListener,
  trustedRequests,
} from '../../platform/server/router.ts';
import type { SecretStore } from '../../platform/server/secrets.ts';
import type { IdentityFactory } from './identity.ts';
import { type AppStorage, createFileStorage } from './storage.ts';

export {
  type AppConfig,
  type HostedConfig,
  loadConfig,
  type LocalConfig,
} from '../../platform/server/config.ts';
export type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
export type {
  DeviceSignIn,
  IdentityContext,
  IdentityFactory,
  IdentityResolver,
} from './identity.ts';
export { type RawRoute, REQUEST_SECRET_COOKIE } from '../../platform/server/router.ts';
export { BOOTSTRAP_PATH, BOOTSTRAP_TTL_MS } from '../../platform/server/bootstrap.ts';
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
  /**
   * Development only: also trusts the Vite dev server's origin on `config.uiPort`, which proxies
   * `/api` here. Without it, the server trusts only its own origin.
   */
  devUiOrigin?: boolean;
  /**
   * Answers only requests whose `REQUEST_SECRET_COOKIE` cookie holds this value, apart from the
   * health check, so other programs and users on the machine can't call the server. For an app
   * that embeds the server and sets the cookie in its own browser; `yarn start` leaves it unset.
   */
  requestSecret?: string;
  /**
   * Local mode, with `requestSecret`: opening `BOOTSTRAP_PATH?code=<this>` once, within
   * `BOOTSTRAP_TTL_MS`, sets the request secret's cookie, for an app that can't set it in its
   * webview itself. Never put it where other programs can read it, such as argv or the environment.
   */
  bootstrapCode?: string;
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
  const staticDir = usableStaticDir(overrides.staticDir, warn);
  const bootstrap = bootstrapRouteFor(config, overrides);

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
    ...trustedRequests(config, port, { devUiOrigin: overrides.devUiOrigin }),
    staticDir,
    routes: bootstrap ? [...app.routes, bootstrap] : app.routes,
    requestSecret: overrides.requestSecret,
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

/** HTTP to anything but this machine, where nothing protects what travels over it. */
function isPlainHttpOrigin(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return (
    protocol === 'http:' &&
    !LOOPBACK_HOSTNAMES.some((name) => name === hostname) &&
    hostname !== '[::1]'
  );
}

function bootstrapRouteFor(config: AppConfig, overrides: ServerOverrides): RawRoute | undefined {
  const { bootstrapCode, requestSecret } = overrides;
  if (bootstrapCode === undefined) {
    return undefined;
  }
  if (config.mode !== 'local' || requestSecret === undefined) {
    throw new Error('A bootstrap code needs local mode and a request secret');
  }
  return bootstrapRoute({ code: bootstrapCode, requestSecret });
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
