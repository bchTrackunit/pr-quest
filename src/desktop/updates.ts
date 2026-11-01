import { inspect } from 'node:util';

import { isPublishable, type ReleaseRepo } from './release.ts';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The part of electron-updater's `autoUpdater` this uses. */
export interface Updater {
  checkForUpdatesAndNotify: () => Promise<unknown>;
  allowDowngrade: boolean;
  readonly channel: string | null;
}

/**
 * How this installation gets new versions:
 * - `platform`: electron-updater's own updater, from the zip on macOS or the installer on Windows.
 * - `appimage`: the AppImage replaces itself, as the user, without administrator rights.
 * - `download`: no automatic updates; the user downloads the new package from the release page.
 *   This covers the deb, for which electron-updater would install the download as root through
 *   pkexec, trusting only a checksum from the same release.
 *
 * electron-updater picks its Linux updater from a `package-type` file in the app's resources, but
 * electron-builder builds the AppImage and the deb from one folder at once, so that file isn't a
 * reliable sign of a deb. APPIMAGE is, because the AppImage runtime sets it.
 */
export type UpdateSource = 'platform' | 'appimage' | 'download';

export function updateSource(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): UpdateSource {
  if (options.platform !== 'linux') {
    return 'platform';
  }
  return options.env.APPIMAGE === undefined || options.env.APPIMAGE === ''
    ? 'download'
    : 'appimage';
}

/**
 * Keeps an update from replacing the app with an older version. electron-updater allows that once a
 * channel is set, so an updater with one is refused instead.
 */
export function prepareUpdater<T extends Updater>(updater: T): T {
  if (updater.channel !== null) {
    throw new Error(
      `the updater is set to the ${updater.channel} channel, which allows downgrades`,
    );
  }
  updater.allowDowngrade = false;
  return updater;
}

export interface UpdatesEnabledOptions {
  isPackaged: boolean;
  /** Whether this bundle was built as a release; see `RELEASE_BUILD`. */
  releaseBuild: boolean;
  repo: ReleaseRepo;
  env: NodeJS.ProcessEnv;
}

/**
 * Only a packaged release build of a real repository updates itself, so a locally packaged app
 * never installs whatever a stranger publishes under the placeholder owner.
 * `PR_QUEST_DISABLE_UPDATES=1` turns checks off, for managed machines and for smoke tests.
 */
export function updatesEnabled(options: UpdatesEnabledOptions): boolean {
  return (
    options.isPackaged &&
    options.releaseBuild &&
    isPublishable(options.repo) &&
    options.env.PR_QUEST_DISABLE_UPDATES !== '1'
  );
}

/**
 * Checks GitHub Releases now and every few hours. electron-updater downloads a newer version in
 * the background, shows a notification and installs it when the app quits. Returns a stop function.
 */
export function scheduleUpdateChecks(
  updater: Pick<Updater, 'checkForUpdatesAndNotify'>,
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
