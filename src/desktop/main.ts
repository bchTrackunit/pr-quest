import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
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
import { forbiddenSwitch } from './launchGuard.ts';
import { menuTemplate } from './menu.ts';
import { externalUrl, isAllowedPermission, isAppUrl } from './navigation.ts';
import { type DesktopPreferences, readPreferences, writePreferences } from './preferences.ts';
import { LATEST_RELEASE_URL, README_URL, RELEASE_REPO } from './release.ts';
import { secretsNotice } from './secretsNotice.ts';
import {
  prepareUpdater,
  startUpdateChecks,
  updatesEnabled,
  updateSource,
  type UpdateSource,
} from './updates.ts';

/** `PR_QUEST_SMOKE_TEST=1` checks a build, prints the results and exits; see smoke.ts. */
const smokeTest = process.env.PR_QUEST_SMOKE_TEST === '1';
/** After this the smoke test checks the window anyway, so a page that never loads fails it. */
const SMOKE_LOAD_TIMEOUT_MS = 30_000;
/** How long quitting waits for the server to close before it gives up on a stuck connection. */
const CLOSE_TIMEOUT_MS = 5000;
/** A renderer that crashes again sooner than this stays down instead of reloading in a loop. */
const RELOAD_INTERVAL_MS = 10_000;
/** What the page's Content Security Policy blocked, which fails the smoke test. */
const cspViolations: Array<string> = [];

const forbidden = forbiddenSwitch({
  isPackaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
});
if (forbidden !== undefined) {
  process.stderr.write(`[pr-quest] Refusing to start with --${forbidden}\n`);
  app.exit(1);
} else if (smokeTest && process.env.PR_QUEST_STATE_DIR === undefined) {
  // Otherwise the checks would run against the player's real ~/.pr-quest.
  process.stderr.write(
    '[pr-quest] The smoke test needs PR_QUEST_STATE_DIR; see scripts/desktop-smoke.ts\n',
  );
  app.exit(2);
} else {
  if (smokeTest && process.env.PR_QUEST_STATE_DIR !== undefined) {
    // Its own profile, so it runs next to an open PR Quest instead of handing over to it. It goes in
    // the throwaway state directory, which desktop-smoke.ts deletes once Chromium has let go of it.
    app.setPath('userData', join(process.env.PR_QUEST_STATE_DIR, 'smoke-profile'));
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
    } else if (server) {
      window = openWindow(server.url, log);
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
    void Promise.race([running.close(), delay(CLOSE_TIMEOUT_MS)])
      .then(() => log.close())
      .finally(() => {
        app.quit();
      });
  });

  void app
    .whenReady()
    .then(async () => {
      const updates = updatesEnabled({
        isPackaged: app.isPackaged,
        releaseBuild: RELEASE_BUILD,
        repo: RELEASE_REPO,
        env: process.env,
      })
        ? updateSource({ platform: process.platform, env: process.env })
        : undefined;
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          menuTemplate({
            platform: process.platform,
            appName: app.name,
            openHelp: () => {
              void shell.openExternal(README_URL);
            },
            ...(updates === 'download'
              ? {
                  openDownloads: () => {
                    void shell.openExternal(LATEST_RELEASE_URL);
                  },
                }
              : {}),
            devTools: !app.isPackaged,
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
      if (updates === 'download') {
        log.info(`this install doesn't update itself; new versions are at ${LATEST_RELEASE_URL}`);
      } else if (updates !== undefined) {
        stopUpdates = startUpdateChecks(() => {
          const updater = openUpdater(updates);
          updater.logger = { info: log.info, warn: log.warn, error: log.warn };
          return updater;
        }, log);
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
  // details.requestingUrl names the frame that asked, which may not be the page's top frame.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(isAllowedPermission(permission, details.requestingUrl, origin));
    },
  );
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin, origin),
  );
}

/**
 * The updater for an install that updates itself. On Linux this is always the AppImage updater:
 * electron-updater's own pick could be its deb updater, which installs as root.
 */
function openUpdater(source: Exclude<UpdateSource, 'download'>): electronUpdater.AppUpdater {
  return source === 'appimage'
    ? new electronUpdater.AppImageUpdater()
    : electronUpdater.autoUpdater;
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
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
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
  const stayInApp = (event: Electron.Event<{ url: string }>): void => {
    if (!isAppUrl(event.url, origin)) {
      event.preventDefault();
      openExternally(event.url);
    }
  };
  window.webContents.on('will-navigate', stayInApp);
  window.webContents.on('will-redirect', stayInApp);
  if (smokeTest) {
    window.webContents.on('console-message', ({ message }) => {
      if (message.includes('Content Security Policy')) {
        cspViolations.push(message);
      }
    });
  }
  let lastReload = 0;
  window.webContents.on('render-process-gone', (_event, details) => {
    log.warn(`the window's renderer stopped: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && Date.now() - lastReload > RELOAD_INTERVAL_MS) {
      lastReload = Date.now();
      window.webContents.reload();
    }
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
  const ok = await runSmokeTest(window, server.url, cspViolations, [
    {
      // The smoke test turns update checks off, so this sets up the updater a release would use
      // without checking.
      name: 'updater',
      run: () => {
        const source = updateSource({ platform: process.platform, env: process.env });
        if (source === 'download') {
          return Promise.resolve("this install doesn't update itself");
        }
        return Promise.resolve(`${prepareUpdater(openUpdater(source)).constructor.name} is set up`);
      },
    },
  ]);
  // A page that never finished loading keeps its connection open, and closing waits for it.
  await Promise.race([server.close(), delay(CLOSE_TIMEOUT_MS)]);
  await log.close();
  app.exit(ok ? 0 : 1);
}
