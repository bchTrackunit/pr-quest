import { fileURLToPath } from 'node:url';

import { runCli } from './app/cli.ts';

// The entry of the production build, so these paths are relative to `apps/server/dist/main.js`.
void runCli({
  staticDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
  legacyEnvFilePath: fileURLToPath(new URL('../../../.env.local', import.meta.url)),
});
