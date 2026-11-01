import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openLogFile } from './logFile.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-log-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openLogFile', () => {
  test('appends timestamped lines', async () => {
    const log = openLogFile(join(dir, 'logs', 'main.log'), { echo: false });

    log.info('started');
    log.warn('something odd');
    await log.close();

    const lines = (await readFile(join(dir, 'logs', 'main.log'), 'utf8')).trim().split('\n');
    expect(lines).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO started$/),
      expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARN something odd$/),
    ]);
  });

  test('drops lines logged after closing, as during quit', async () => {
    const log = openLogFile(join(dir, 'main.log'), { echo: false });
    await log.close();

    log.warn('late');
    // A write after the end fails asynchronously, as an uncaught stream error.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readFile(join(dir, 'main.log'), 'utf8')).toBe('');
  });

  test('starts a new file when the old one is large, keeping one previous', async () => {
    const file = join(dir, 'main.log');
    await writeFile(file, 'x'.repeat(100));

    const log = openLogFile(file, { echo: false, maxBytes: 50 });
    log.info('fresh');
    await log.close();

    expect((await readdir(dir)).toSorted()).toEqual(['main.log', 'main.old.log']);
    expect(await readFile(file, 'utf8')).toContain('fresh');
  });
});
