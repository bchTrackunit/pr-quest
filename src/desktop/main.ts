import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';

import {
  loadConfig,
  REQUEST_SECRET_COOKIE,
  type RunningServer,
  type SecretStore,
} from '../app/server/server.ts';
import { RELEASE_BUILD } from './buildFlags.ts';
import { startDesktopServer } from './desktopServer.ts';
import { type Encryptor, keychainUsable, openDesktopSecrets } from './keychainSecrets.ts';
import { type LogFile, openLogFile } from './logFile.ts';
import { menuTemplate } from './menu.ts';
import { externalUrl, isAllowedPermission, isAppUrl } from './navigation.ts';
import { type DesktopPreferences, readPreferences, writePreferences } from './preferences.ts';
import { README_URL, RELEASE_REPO } from './release.ts';
import { secretsNotice } from './secretsNotice.ts';
import { scheduleUpdateChecks, updatesEnabled } from './updates.ts';

/** `PR_QUEST_SMOKE_TEST=1` checks a build, prints the results and exits; see smoke.ts. */
const smokeTest = process.env.PR_QUEST_SMOKE_TEST === '1';
/** After this the smoke test checks the window anyway, so a page that never loads fails it. */
const SMOKE_LOAD_TIMEOUT_MS = 30_000;
const SMOKE_CLOSE_TIMEOUT_MS = 5000;

if (smokeTest) {
  // Its own profile, so it runs next to an open PR Quest instead of handing over to it.
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'pr-quest-smoke-')));
  // Chromium keeps its cookie key in the OS keychain. An unsigned rebuild can't read the item an
  // earlier build created without an access prompt, and pages don't load while that prompt waits.
  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('password-store', 'basic');
}

if (app.requestSingleInstanceLock()) {
  run();
} else {
  app.quit();
}

function run(): void {
  const log = openLogFile(join(app.getPath('logs'), 'main.log'), {
    echo: !app.isPackaged || smokeTest,
  });
  let server: RunningServer | undefined;
  let window: BrowserWindow | undefined;
  let stopUpdates: (() => void) | undefined;

  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });
  // macOS apps stay open without windows; the server keeps polling and the Dock icon reopens one.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (server && BrowserWindow.getAllWindows().length === 0) {
      window = openWindow(server.url, log);
    }
  });
  app.on('will-quit', (event) => {
    stopUpdates?.();
    const running = server;
    if (!running) {
      return;
    }
    server = undefined;
    event.preventDefault();
    void running
      .close()
      .then(() => log.close())
      .finally(() => {
        app.quit();
      });
  });

  void app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          menuTemplate({
            platform: process.platform,
            appName: app.name,
            openHelp: () => {
              void shell.openExternal(README_URL);
            },
          }),
        ),
      );

      // State stays in ~/.pr-quest (or PR_QUEST_STATE_DIR), shared with the CLI.
      const base = loadConfig({ onWarning: log.warn });
      const preferencesFile = join(app.getPath('userData'), 'desktop.json');
      const preferences = await readPreferences(preferencesFile);
      const secrets = await openSecrets(base.stateDir, preferences, preferencesFile, log);
      const { port } = preferences;
      const requestSecret = randomBytes(32).toString('base64url');
      const running = await startDesktopServer(base, port, {
        secrets,
        staticDir: join(app.getAppPath(), 'dist'),
        requestSecret,
        info: log.info,
        warn: log.warn,
      });
      server = running;
      preferences.port = running.port;
      await writePreferences(preferencesFile, preferences);

      // Only this window may call the server; every request it makes, EventSource too, sends this.
      await session.defaultSession.cookies.set({
        url: running.url,
        name: REQUEST_SECRET_COOKIE,
        value: requestSecret,
        httpOnly: true,
        sameSite: 'strict',
      });
      guardPermissions(running.url);
      window = openWindow(running.url, log);

      if (smokeTest) {
        await runSmokeTestAndExit(window, running, log);
        return;
      }
      if (
        updatesEnabled({
          isPackaged: app.isPackaged,
          releaseBuild: RELEASE_BUILD,
          repo: RELEASE_REPO,
          env: process.env,
        })
      ) {
        const { autoUpdater } = electronUpdater;
        autoUpdater.logger = { info: log.info, warn: log.warn, error: log.warn };
        stopUpdates = scheduleUpdateChecks(autoUpdater, log);
      }
    })
    .catch((error: unknown) => {
      log.warn(`failed to start: ${inspect(error)}`);
      if (!smokeTest) {
        dialog.showErrorBox(
          'PR Quest could not start',
          error instanceof Error ? error.message : String(error),
        );
      }
      app.exit(1);
    });
}

/**
 * Opens the saved keys and tells the player when they can't be encrypted, saved or read, asking
 * once whether to save them unencrypted without a keychain. Records that answer in `preferences`.
 */
async function openSecrets(
  stateDir: string,
  preferences: DesktopPreferences,
  preferencesFile: string,
  log: LogFile,
): Promise<SecretStore> {
  // macOS asks before a rebuilt, unsigned app may read its keychain entry, and the question
  // blocks the main process, so a smoke test leaves the keychain alone.
  const encryptor = smokeTest ? undefined : keychain();
  for (;;) {
    const { store, storage } = await openDesktopSecrets(stateDir, {
      encryptor,
      allowPlaintext: preferences.plaintextSecrets === true,
      info: log.info,
      warn: log.warn,
    });
    const notice = smokeTest ? undefined : secretsNotice(storage, preferences.plaintextSecrets);
    if (!notice) {
      return store;
    }
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: notice.message,
      detail: notice.detail,
      buttons: notice.buttons.map((button) => button.label),
      defaultId: 0,
      cancelId: 0,
    });
    const action = notice.buttons[response]?.action ?? 'continue';
    if (action === 'retry') {
      continue;
    }
    if (action === 'keepInMemory' || action === 'savePlaintext') {
      preferences.plaintextSecrets = action === 'savePlaintext';
      await writePreferences(preferencesFile, preferences);
      if (preferences.plaintextSecrets) {
        continue;
      }
    }
    return store;
  }
}

/** The OS keychain through Electron's safeStorage, when it protects anything; see keychainUsable. */
function keychain(): Encryptor | undefined {
  const usable = keychainUsable({
    platform: process.platform,
    isAvailable: safeStorage.isEncryptionAvailable(),
    backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
  });
  return usable ? safeStorage : undefined;
}

/** The UI gets the permissions it uses, and only on its own origin. */
function guardPermissions(appUrl: string): void {
  const { origin } = new URL(appUrl);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isAllowedPermission(permission, webContents.getURL(), origin));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin, origin),
  );
}

/**
 * The window shows only the app. Links to anywhere else, such as a PR on GitHub, open in the system
 * browser, and the page can't open windows of its own.
 */
function openWindow(url: string, log: LogFile): BrowserWindow {
  const { origin } = new URL(url);
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: app.name,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const openExternally = (target: string): void => {
    const external = externalUrl(target);
    if (external === undefined) {
      log.warn(`refused to open a ${URL.parse(target)?.protocol ?? 'malformed'} link`);
      return;
    }
    void shell.openExternal(external);
  };
  window.once('ready-to-show', () => {
    window.show();
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (!isAppUrl(event.url, origin)) {
      event.preventDefault();
      openExternally(event.url);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log.warn(`the window's renderer stopped: ${details.reason} (exit code ${details.exitCode})`);
  });
  window.webContents.loadURL(url).catch((error: unknown) => {
    log.warn(`the window failed to load ${url}: ${inspect(error)}`);
  });
  return window;
}

async function runSmokeTestAndExit(
  window: BrowserWindow,
  server: RunningServer,
  log: LogFile,
): Promise<void> {
  const { runSmokeTest } = await import('./smoke.ts');
  if (window.webContents.isLoading()) {
    await Promise.race([
      once(window.webContents, 'did-finish-load'),
      once(window.webContents, 'did-fail-load'),
      delay(SMOKE_LOAD_TIMEOUT_MS),
    ]);
  }
  log.info(
    `smoke test window: ${window.webContents.isLoading() ? 'still loading' : 'loaded'} ${window.webContents.getURL()}, ${window.isVisible() ? 'visible' : 'hidden'}`,
  );
  const ok = await runSmokeTest(window, server.url);
  // A page that never finished loading keeps its connection open, and closing waits for it.
  await Promise.race([server.close(), delay(SMOKE_CLOSE_TIMEOUT_MS)]);
  await log.close();
  app.exit(ok ? 0 : 1);
}
