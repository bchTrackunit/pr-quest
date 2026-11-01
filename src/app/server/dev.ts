import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';

// `yarn dev` runs this from source; Vite serves the UI and proxies `/api` here.
void runCli({
  legacyEnvFilePath: fileURLToPath(new URL('../../../.env.local', import.meta.url)),
  devUiOrigin: true,
});
