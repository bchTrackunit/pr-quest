import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readPreferences, writePreferences } from './preferences.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-prefs-'));
  file = join(dir, 'desktop.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('desktop preferences', () => {
  test('are empty before the first run', async () => {
    await expect(readPreferences(file)).resolves.toEqual({});
  });

  test('remember the server port', async () => {
    await writePreferences(file, { port: 53124 });

    await expect(readPreferences(file)).resolves.toEqual({ port: 53124 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, port: 53124 });
  });

  test.each([
    ['unreadable', '{ nope'],
    ['an invalid port', JSON.stringify({ version: 1, port: 70000 })],
    ['a newer version', JSON.stringify({ version: 2, port: 53124 })],
  ])('start over from %s', async (_label, text) => {
    await writeFile(file, text);

    await expect(readPreferences(file)).resolves.toEqual({});
  });
});
