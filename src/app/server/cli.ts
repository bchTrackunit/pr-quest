import { inspect } from 'node:util';

import { loadConfig } from '../../platform/server/config.ts';
import { startServer } from './server.ts';

export interface CliOptions {
  /** `.env.local` at the repo root, read with the lowest precedence. */
  legacyEnvFilePath?: string;
  /** Serves the built UI from here, on the API's port. */
  staticDir?: string;
  /** Trusts the Vite dev server on the UI port, which proxies `/api` to this server. */
  devUiOrigin?: boolean;
}

/** Starts the server from the environment and stops it on SIGINT or SIGTERM. */
export async function runCli(options: CliOptions): Promise<void> {
  try {
    const config = loadConfig({ legacyEnvFilePath: options.legacyEnvFilePath });
    const server = await startServer(config, {
      staticDir: options.staticDir,
      devUiOrigin: options.devUiOrigin,
    });
    const shutdown = (): void => {
      void server.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`[pr-quest] failed to start: ${inspect(error)}\n`);
    process.exit(1);
  }
}
