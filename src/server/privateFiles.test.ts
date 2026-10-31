import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writePrivateJson } from './privateFiles.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-private-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writePrivateJson', () => {
  test('writes pretty JSON with mode 0600 and leaves no temp file', async () => {
    const file = join(dir, 'secrets.json');

    await writePrivateJson(file, { version: 1 });

    expect(await readFile(file, 'utf8')).toBe('{\n  "version": 1\n}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secrets.json']);
  });

  test('removes the temp copy when the rename fails', async () => {
    const file = join(dir, 'secrets.json');
    await mkdir(file);
    await writeFile(join(file, 'keep'), '');

    await expect(writePrivateJson(file, { secrets: { github: 'gho_x' } })).rejects.toThrow();

    expect(await readdir(dir)).toEqual(['secrets.json']);
  });
});
