import { createServer } from 'node:http';
import { inspect } from 'node:util';

import { createApp } from './app.ts';
import { loadConfig } from '../../platform/server/config.ts';
import { readGhToken } from '../../features/auth/server/ghToken.ts';
import { createRouter, loopbackOrigins } from '../../platform/server/router.ts';

const info = (message: string): void => {
  process.stdout.write(`[pr-quest] ${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`[pr-quest] ${message}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config, ghToken: readGhToken, info, warn });

  const server = createServer(
    createRouter(app.handlers, {
      allowedOrigins: loopbackOrigins([config.port, config.uiPort]),
      onUnexpectedError: (error) => {
        warn(`unexpected error ${inspect(error)}`);
      },
    }),
  );

  server.listen(config.port, config.host, () => {
    info(`API listening on http://${config.host}:${config.port}`);
    info(`state in ${config.stateDir}`);
    void app.warmUp();
  });

  const shutdown = (): void => {
    app.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  warn(`failed to start: ${inspect(error)}`);
  process.exit(1);
});
