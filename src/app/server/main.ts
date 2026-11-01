import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';

// The entry of the production build, so these paths are relative to `dist-server/main.js`.
void runCli({
  staticDir: fileURLToPath(new URL('../dist', import.meta.url)),
  legacyEnvFilePath: fileURLToPath(new URL('../.env.local', import.meta.url)),
});
