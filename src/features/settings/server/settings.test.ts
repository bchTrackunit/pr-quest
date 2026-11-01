import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { FileSettingsStore, TimeZoneChangeTooSoon } from './settings.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileSettingsStore', () => {
  test('defaults to the Cursor provider and no model overrides', async () => {
    const settings = await FileSettingsStore.open(dir);

    expect(settings.get()).toEqual({ reviewProvider: 'cursor', models: {} });
  });

  test('saves the provider and models to settings.json', async () => {
    const settings = await FileSettingsStore.open(dir);

    await settings.update({ reviewProvider: 'claude', models: { claude: 'claude-opus-5-5' } });

    expect(settings.get()).toEqual({
      reviewProvider: 'claude',
      models: { claude: 'claude-opus-5-5' },
    });
    const file = join(dir, 'settings.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
    expect((await FileSettingsStore.open(dir)).get().reviewProvider).toBe('claude');
  });

  test('merges model updates and clears a model set to null', async () => {
    const settings = await FileSettingsStore.open(dir);
    await settings.update({ models: { cursor: 'composer-2', claude: 'claude-opus-5-5' } });

    await settings.update({ models: { cursor: null } });

    expect(settings.get().models).toEqual({ claude: 'claude-opus-5-5' });
  });

  test('saves the time zone and clears it with null', async () => {
    const settings = await FileSettingsStore.open(dir);

    await settings.update({ timeZone: 'Europe/Copenhagen' });
    expect((await FileSettingsStore.open(dir)).get().timeZone).toBe('Europe/Copenhagen');

    await settings.update({ timeZone: null });
    expect((await FileSettingsStore.open(dir)).get()).toEqual({
      reviewProvider: 'cursor',
      models: {},
      timeZoneChangedAt: expect.any(String),
    });
  });

  test('records when the time zone last changed, and only when it changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
      const settings = await FileSettingsStore.open(dir);
      await settings.update({ timeZone: 'Asia/Tokyo' });

      vi.setSystemTime(new Date('2026-11-01T11:00:00Z'));
      await settings.update({ timeZone: 'Asia/Tokyo' });
      await settings.update({ reviewProvider: 'claude' });
      await settings.update({ timeZone: null, models: {} });
      vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
      await settings.update({ timeZone: null });

      expect((await FileSettingsStore.open(dir)).get()).toEqual({
        reviewProvider: 'claude',
        models: {},
        timeZoneChangedAt: '2026-11-01T11:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('refuses a time zone change sooner than the limit, saving nothing', async () => {
    const settings = await FileSettingsStore.open(dir);
    const day = { minTimeZoneIntervalMs: 24 * 60 * 60_000 };
    await settings.update(
      { timeZone: 'Asia/Tokyo' },
      { ...day, now: new Date('2026-11-01T10:00:00Z') },
    );

    await expect(
      settings.update(
        { timeZone: 'Europe/Copenhagen', reviewProvider: 'claude' },
        { ...day, now: new Date('2026-11-02T09:59:59Z') },
      ),
    ).rejects.toBeInstanceOf(TimeZoneChangeTooSoon);
    await settings.update(
      { timeZone: 'Europe/Copenhagen' },
      { ...day, now: new Date('2026-11-02T10:00:00Z') },
    );

    expect((await FileSettingsStore.open(dir)).get()).toEqual({
      reviewProvider: 'cursor',
      models: {},
      timeZone: 'Europe/Copenhagen',
      timeZoneChangedAt: '2026-11-02T10:00:00.000Z',
    });
  });

  test('keeps the time zone when a patch leaves it out', async () => {
    const settings = await FileSettingsStore.open(dir);
    await settings.update({ timeZone: 'Asia/Tokyo' });

    await settings.update({ reviewProvider: 'claude' });

    expect(settings.get().timeZone).toBe('Asia/Tokyo');
  });

  test('drops a time zone this machine does not know and keeps the other settings', async () => {
    const text = JSON.stringify({
      version: 1,
      reviewProvider: 'claude',
      models: {},
      timeZone: 'Mars/Olympus_Mons',
    });
    await writeFile(join(dir, 'settings.json'), text);

    expect((await FileSettingsStore.open(dir)).get()).toEqual({
      reviewProvider: 'claude',
      models: {},
    });
  });

  test('ignores an unreadable file and warns', async () => {
    await writeFile(join(dir, 'settings.json'), '{"reviewProvider":"nope"}');
    const onWarning = vi.fn();

    const settings = await FileSettingsStore.open(dir, { onWarning });

    expect(settings.get().reviewProvider).toBe('cursor');
    expect(onWarning).toHaveBeenCalled();
  });

  test('refuses a file from a newer PR Quest instead of overwriting it later', async () => {
    const text = JSON.stringify({ version: 3, reviewProvider: 'claude', models: {} });
    await writeFile(join(dir, 'settings.json'), text);

    await expect(FileSettingsStore.open(dir)).rejects.toThrow(
      /newer version of PR Quest.*version 3/,
    );

    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(text);
  });
});
