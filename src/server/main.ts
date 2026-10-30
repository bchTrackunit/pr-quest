import { createServer } from 'node:http';
import { inspect } from 'node:util';

import { loadConfig } from './config.ts';
import { createHandlers } from './handlers.ts';
import { createRouter } from './router.ts';

const config = loadConfig();
const server = createServer(
  createRouter(createHandlers(config), {
    onUnexpectedError: (error) => {
      process.stderr.write(`[pr-quest] unexpected error ${inspect(error)}\n`);
    },
  }),
);

server.listen(config.port, config.host, () => {
  process.stdout.write(`[pr-quest] API listening on http://${config.host}:${config.port}\n`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
