import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  prepareUpdater,
  scheduleUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
  updatesEnabled,
  updateSource,
} from './updates.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('updatesEnabled', () => {
  const release = {
    isPackaged: true,
    releaseBuild: true,
    repo: { owner: 'octocat', repo: 'pr-quest' },
    env: {},
  };

  test('checks for updates in a packaged release build of a real repository', () => {
    expect(updatesEnabled(release)).toBe(true);
  });

  test('never in development, where there is nothing to update', () => {
    expect(updatesEnabled({ ...release, isPackaged: false })).toBe(false);
  });

  test('never in a package built without the release flag, such as a local build', () => {
    expect(updatesEnabled({ ...release, releaseBuild: false })).toBe(false);
  });

  test('never while the repository owner is the placeholder', () => {
    expect(updatesEnabled({ ...release, repo: { owner: 'CHANGE-ME', repo: 'pr-quest' } })).toBe(
      false,
    );
  });

  test('not when PR_QUEST_DISABLE_UPDATES is set', () => {
    expect(updatesEnabled({ ...release, env: { PR_QUEST_DISABLE_UPDATES: '1' } })).toBe(false);
  });
});

describe('updateSource', () => {
  test.each(['darwin', 'win32'] as const)(
    '%s updates with its own installer format',
    (platform) => {
      expect(updateSource({ platform, env: {} })).toBe('platform');
    },
  );

  test('an AppImage replaces itself, which needs no administrator rights', () => {
    expect(
      updateSource({ platform: 'linux', env: { APPIMAGE: '/home/me/PR Quest.AppImage' } }),
    ).toBe('appimage');
  });

  test('anything else on Linux, such as a deb install, is updated by downloading the new package', () => {
    expect(updateSource({ platform: 'linux', env: {} })).toBe('download');
    expect(updateSource({ platform: 'linux', env: { APPIMAGE: '' } })).toBe('download');
  });
});

describe('prepareUpdater', () => {
  const fresh = () => ({ checkForUpdatesAndNotify: vi.fn(), allowDowngrade: false, channel: null });

  test('never lets a release install an older version', () => {
    const updater = { ...fresh(), allowDowngrade: true };

    expect(prepareUpdater(updater)).toBe(updater);
    expect(updater.allowDowngrade).toBe(false);
  });

  test('refuses an updater set to a channel, which would allow downgrades again', () => {
    expect(() => prepareUpdater({ ...fresh(), channel: 'beta' })).toThrow(/channel/);
  });
});

describe('scheduleUpdateChecks', () => {
  test('checks at once, then on an interval until stopped', async () => {
    const updater = { checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null) };

    const stop = scheduleUpdateChecks(updater, { warn: vi.fn() });
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
  });

  test('reports a failed check and keeps checking', async () => {
    const updater = {
      checkForUpdatesAndNotify: vi
        .fn()
        .mockRejectedValueOnce(new Error('HttpError: 404'))
        .mockResolvedValue(null),
    };
    const warn = vi.fn();

    const stop = scheduleUpdateChecks(updater, { warn });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('404'));

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
    stop();
  });
});
