import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SecretStore } from './secrets.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-secrets-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('SecretStore', () => {
  test('starts empty when there is no file', async () => {
    const secrets = await SecretStore.open(dir);

    expect(secrets.get('cursor')).toBeUndefined();
  });

  test('saves secrets to secrets.json with mode 0600 in a 0700 directory', async () => {
    const stateDir = join(dir, 'state');
    const secrets = await SecretStore.open(stateDir);

    await secrets.set('anthropic', 'sk-ant-secret');

    const file = join(stateDir, 'secrets.json');
    expect(await modeOf(stateDir)).toBe(0o700);
    expect(await modeOf(file)).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      secrets: { anthropic: 'sk-ant-secret' },
    });
    expect((await SecretStore.open(stateDir)).get('anthropic')).toBe('sk-ant-secret');
  });

  test('tightens a secrets file that other users can read', async () => {
    const file = join(dir, 'secrets.json');
    await writeFile(file, JSON.stringify({ version: 1, secrets: { linear: 'lin' } }));
    await chmod(file, 0o644);

    const secrets = await SecretStore.open(dir);

    expect(secrets.get('linear')).toBe('lin');
    expect(await modeOf(file)).toBe(0o600);
  });

  test('deletes a secret', async () => {
    const secrets = await SecretStore.open(dir);
    await secrets.set('github', 'gho_x');
    await secrets.set('cursor', 'key_c');

    await secrets.delete('github');

    expect(secrets.get('github')).toBeUndefined();
    expect((await SecretStore.open(dir)).get('cursor')).toBe('key_c');
  });

  test('writes atomically, leaving no temp files', async () => {
    const secrets = await SecretStore.open(dir);

    await Promise.all([secrets.set('cursor', 'a'), secrets.set('linear', 'b')]);

    expect(await readdir(dir)).toEqual(['secrets.json']);
    expect((await SecretStore.open(dir)).get('linear')).toBe('b');
  });

  test('moves an unreadable file aside without echoing its contents', async () => {
    await writeFile(join(dir, 'secrets.json'), '{ not json sk-leak');
    const onWarning = vi.fn();

    const secrets = await SecretStore.open(dir, { onWarning });

    expect(secrets.get('cursor')).toBeUndefined();
    expect((await readdir(dir)).some((name) => name.startsWith('secrets.json.corrupt-'))).toBe(
      true,
    );
    expect(onWarning).toHaveBeenCalledWith(expect.not.stringContaining('sk-leak'));
  });
});
