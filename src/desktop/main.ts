import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

import { loadConfig, startServer } from '../app/server/server.ts';

// Electron emits `ready` only once the ESM entry has finished evaluating, so awaiting it at the top
// level would never resolve.
void app.whenReady().then(async () => {
  const config = { ...loadConfig(), port: 0, uiPort: 0 };
  const server = await startServer(config, { staticDir: join(app.getAppPath(), 'dist') });
  const window = new BrowserWindow({ width: 1280, height: 860 });
  await window.loadURL(server.url);

  if (process.env.PR_QUEST_SMOKE_TEST === '1') {
    const { runSmokeTest } = await import('./smoke.ts');
    const ok = await runSmokeTest(window, server.url);
    await server.close();
    app.exit(ok ? 0 : 1);
  }
});
