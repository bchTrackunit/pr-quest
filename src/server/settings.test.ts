import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SettingsStore } from './settings.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  test('defaults to the Cursor provider and no model overrides', async () => {
    const settings = await SettingsStore.open(dir);

    expect(settings.get()).toEqual({ reviewProvider: 'cursor', models: {} });
  });

  test('saves the provider and models to settings.json', async () => {
    const settings = await SettingsStore.open(dir);

    await settings.update({ reviewProvider: 'claude', models: { claude: 'claude-opus-5-5' } });

    expect(settings.get()).toEqual({
      reviewProvider: 'claude',
      models: { claude: 'claude-opus-5-5' },
    });
    const file = join(dir, 'settings.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
    expect((await SettingsStore.open(dir)).get().reviewProvider).toBe('claude');
  });

  test('merges model updates and clears a model set to null', async () => {
    const settings = await SettingsStore.open(dir);
    await settings.update({ models: { cursor: 'composer-2', claude: 'claude-opus-5-5' } });

    await settings.update({ models: { cursor: null } });

    expect(settings.get().models).toEqual({ claude: 'claude-opus-5-5' });
  });

  test('ignores an unreadable file and warns', async () => {
    await writeFile(join(dir, 'settings.json'), '{"reviewProvider":"nope"}');
    const onWarning = vi.fn();

    const settings = await SettingsStore.open(dir, { onWarning });

    expect(settings.get().reviewProvider).toBe('cursor');
    expect(onWarning).toHaveBeenCalled();
  });

  test('refuses a file from a newer PR Quest instead of overwriting it later', async () => {
    const text = JSON.stringify({ version: 3, reviewProvider: 'claude', models: {} });
    await writeFile(join(dir, 'settings.json'), text);

    await expect(SettingsStore.open(dir)).rejects.toThrow(/newer version of PR Quest.*version 3/);

    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(text);
  });
});
