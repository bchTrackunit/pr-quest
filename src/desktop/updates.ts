import { inspect } from 'node:util';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The part of electron-updater's `autoUpdater` this uses. */
export interface Updater {
  checkForUpdatesAndNotify: () => Promise<unknown>;
}

/**
 * Only a packaged build has a release to update from. `PR_QUEST_DISABLE_UPDATES=1` turns checks
 * off, for managed machines and for smoke tests.
 */
export function updatesEnabled(options: { isPackaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  return options.isPackaged && options.env.PR_QUEST_DISABLE_UPDATES !== '1';
}

/**
 * Checks GitHub Releases now and every few hours. electron-updater downloads a newer version in
 * the background, shows a notification and installs it when the app quits. Returns a stop function.
 */
export function scheduleUpdateChecks(
  updater: Updater,
  log: { warn: (message: string) => void },
): () => void {
  const check = (): void => {
    updater.checkForUpdatesAndNotify().catch((error: unknown) => {
      log.warn(`update check failed: ${error instanceof Error ? error.message : inspect(error)}`);
    });
  };
  check();
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  return () => {
    clearInterval(timer);
  };
}
