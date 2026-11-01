import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { scheduleUpdateChecks, UPDATE_CHECK_INTERVAL_MS, updatesEnabled } from './updates.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('updatesEnabled', () => {
  test('checks for updates in a packaged build', () => {
    expect(updatesEnabled({ isPackaged: true, env: {} })).toBe(true);
  });

  test('never in development, where there is nothing to update', () => {
    expect(updatesEnabled({ isPackaged: false, env: {} })).toBe(false);
  });

  test('not when PR_QUEST_DISABLE_UPDATES is set', () => {
    expect(updatesEnabled({ isPackaged: true, env: { PR_QUEST_DISABLE_UPDATES: '1' } })).toBe(
      false,
    );
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
